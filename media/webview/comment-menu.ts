/**
 * Req 23 US-23.1: the "Add Comment" entry point — an editor context menu on
 * right-click, and the composer card it opens.
 *
 * The webview has no context menu of its own today, so this module owns both
 * halves: the menu (Add Comment above the clipboard group, matching the design
 * handoff) and the anchored composer. Commenting never rewrites document text —
 * nothing in this file inserts a character into the `.md`; the anchor is a
 * session-only DOM attribute (block-map.ts's COMMENT_ANCHOR_ATTR, stripped by
 * turndown.ts) and the thread itself is created host-side.
 *
 * US-23.4 added the anchor snapshot this module records at creation time
 * (recorded text + nearest heading) and the hand-off to comment-resolve.ts,
 * which owns re-resolution across later edits.
 *
 * Out of scope here (later stories in Req 23): gutter pins/highlight overlay
 * (US-23.2), resolve flow (US-23.3), sidecar persistence (US-23.5).
 */
import {
  commentAnchorLine,
  ensureCommentAnchorId,
  findCommentAnchor,
  nearestHeadingBefore,
  resolveCommentAnchorNode,
} from './block-map';
import type { CommentResolveController, ThreadAnchorSeed } from './comment-resolve';
import { COMMENT_ANCHOR_ACTIVE_CLASS, COMMENT_COMPOSER_CLASS, COMMENT_COMPOSER_INPUT_CLASS } from './constants';
import { el, getOffsetWithin, neutralizeBodyText, normalizeBodyEol, positionNear, showToast } from './dom-utils';
import { initPopoverDismiss } from './escape-stack';
import { lockPageScroll, positionMenuClearOf, unlockPageScroll } from './menu-popup';
import type { VsCodeApi } from './vscode-api';

/** The anchored node + within-node character offsets one comment attaches to (US-23.1 AC3). */
interface PendingAnchor {
  node: HTMLElement;
  anchorId: string;
  offsetStart: number;
  offsetEnd: number;
  line: number;
  /** Text the anchor covers — shown as the composer's quote; empty for a bare caret. */
  quote: string;
  /**
   * US-23.4 tier 2/3 snapshot, captured here because it must describe the node
   * as it was when the comment was written: the anchored node's WHOLE text (so a
   * paragraph reflowing its line breaks still matches) and the heading it sat
   * under (a tie-breaker between structurally identical nodes in two sections).
   */
  recordedText: string;
  nearestHeading: string;
}

/**
 * Everything about a thread the webview knows BEFORE the host confirms it.
 * `status`/`replies`/`statusChanges` are also omitted here (US-23.2, US-23.11) —
 * a brand-new thread is always Open with no replies and no transitions, filled
 * in at the final `resolve.register()` call alongside author/createdAt, not
 * carried through the in-flight guard.
 */
type PendingSeed = Omit<
  ThreadAnchorSeed,
  'author' | 'createdAt' | 'status' | 'replies' | 'statusChanges'
>;

/**
 * Per-webview-load randomness in the thread handle (US-23.4). The document uri
 * alone is not enough: closing and reopening the same file restarts the request
 * counter while the host's thread registry survives, so the reopened webview
 * would mint handles that collide with the still-registered ones.
 */
const sessionSalt = Math.random().toString(36).slice(2, 10);

const BUBBLE_PATH = 'M21 12a8 8 0 0 1-8 8H7l-4 3v-6.5A8 8 0 0 1 11 4h2a8 8 0 0 1 8 8z';

function bubbleIcon(className: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.9');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', BUBBLE_PATH);
  svg.appendChild(path);
  return svg;
}

/**
 * Cross-platform trap (CLAUDE.md): a shortcut label must never hardcode `⌘`.
 * macOS shows the glyph, every other platform shows `Ctrl+`.
 */
function primaryModifierLabel(): string {
  const platform = navigator.userAgent;
  return /Mac|iPhone|iPad/.test(platform) ? '⌘' : 'Ctrl+';
}

export interface CommentMenuController {
  /** Host reply hook — clears the in-flight guard and reports a refusal to the Reviewer. */
  notifyCreateResult(requestId: number, ok: boolean, error?: string, author?: string, timestamp?: string): void;
  /** Seed from `InitConfig.docUri` — echoed back so the host never creates a thread on the wrong document. */
  setDocUri(uri: string): void;
  /** Seed from `InitConfig.commentAuthorName` — display only (the host resolves the real author at create time). */
  setAuthorName(name: string): void;
  /**
   * Req 23 US-23.10 AC7: the document-level reason "Add Comment" must be
   * disabled up front (untitled / non-`file` scheme / outside the allowed
   * workspace roots — or a sidecar the host could not read), or undefined
   * when the document has no such problem. Sourced from the SAME
   * `commentThreadsSync.sidecar.problem` field US-23.9's Comment tab already
   * reads — not a new channel.
   */
  setDocumentGuard(reason: string | undefined): void;
  /**
   * Req 24 US-23.18 AC7: `#content` finished a render pass — re-check the open
   * composer's anchor and refuse Submit if it no longer resolves, instead of
   * waiting for the Reviewer to press Submit and be refused then. Called from
   * `renderDocument`, beside every other module's `refresh()`.
   */
  refreshTarget(): void;
}

export function initCommentMenu(
  content: HTMLElement,
  vscode: VsCodeApi,
  resolve: CommentResolveController
): CommentMenuController {
  let docUri = '';
  let authorName = '';
  let requestSeq = 0;
  /**
   * US-23.1: dedup guard — a second "Add Comment" on the same in-flight
   * selection must be a no-op, or one action creates two threads. Holds the
   * requestId until the host replies (either outcome releases it).
   */
  let inFlightRequestId: number | undefined;
  /**
   * US-23.4: what to hand the resolver once the host confirms the thread exists.
   * The author and creation timestamp are missing on purpose — they come back
   * with the host's reply, since only the host resolves the real author.
   */
  let inFlightSeed: PendingSeed | undefined;
  let pending: PendingAnchor | undefined;
  /**
   * US-23.10 AC7: the up-front reason "Add Comment" is disabled for the WHOLE
   * document (untitled / non-`file` scheme / outside the allowed workspace
   * roots / an unreadable sidecar), pushed via `setDocumentGuard`. Undefined
   * means the document has no such problem — anchorability alone decides.
   */
  let documentGuardReason: string | undefined;

  // --- Context menu ------------------------------------------------------------------------

  const menu = el('div', 'dd-menu-popup comment-context-menu');
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  document.body.appendChild(menu);

  const menuDismiss = initPopoverDismiss(menu, () => unlockPageScroll());

  function closeMenu(): void {
    menuDismiss.close();
  }

  function menuItem(label: string, accel: string, onPick: () => void): HTMLButtonElement {
    const item = el('button', 'dd-menu-item comment-menu-item');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.append(el('span', 'comment-menu-item-label', label));
    if (accel) {
      item.append(el('span', 'comment-menu-item-accel', accel));
    }
    // Keep the document selection alive — the anchor is computed from it on click.
    item.addEventListener('mousedown', (e) => e.preventDefault());
    item.addEventListener('click', () => {
      if (item.getAttribute('aria-disabled') === 'true') {
        return;
      }
      closeMenu();
      onPick();
    });
    return item;
  }

  /**
   * Disabled items keep their place, icon and accelerator (design handoff B3) and
   * carry the reason as a tooltip — the menu never reflows between states. Uses
   * `aria-disabled` rather than the native `disabled` so the tooltip still shows
   * on hover, the same convention as the toolbar's in-code-block buttons.
   */
  function setItemDisabled(item: HTMLElement, disabled: boolean, reason: string): void {
    item.setAttribute('aria-disabled', String(disabled));
    if (disabled) {
      item.title = reason;
    } else {
      item.removeAttribute('title');
    }
  }

  const mod = primaryModifierLabel();
  const addCommentItem = menuItem('Add Comment', '', () => openComposer());
  addCommentItem.prepend(bubbleIcon('comment-menu-item-icon'));
  const cutItem = menuItem('Cut', `${mod}X`, () => document.execCommand('cut'));
  const copyItem = menuItem('Copy', `${mod}C`, () => document.execCommand('copy'));
  const pasteItem = menuItem('Paste', `${mod}V`, () => {
    // execCommand('paste') is the only route that re-enters the editor's own
    // paste pipeline (image paste, smart gap). It is blocked in plain browsers;
    // when it is, say so rather than silently dropping the action.
    if (!document.execCommand('paste')) {
      showToast(`Use ${mod}V to paste here.`);
    }
  });
  menu.append(addCommentItem, el('div', 'dd-menu-sep'), cutItem, copyItem, pasteItem);

  function openMenuAt(x: number, y: number, anchorable: boolean, hasSelection: boolean): void {
    // Re-opening over an already-open menu would double the scroll-lock refcount.
    closeMenu();
    // US-23.10 AC7: a document-level problem always wins — it is discovered
    // up front with its OWN specific reason, never after the anchorability
    // check runs (a doomed create would otherwise show the generic
    // "no commentable block" reason instead of why it is actually refused).
    setItemDisabled(
      addCommentItem,
      documentGuardReason !== undefined || !anchorable,
      documentGuardReason ?? 'No commentable block under the cursor'
    );
    setItemDisabled(cutItem, !hasSelection, 'Nothing selected');
    setItemDisabled(copyItem, !hasSelection, 'Nothing selected');
    menu.hidden = false;
    positionMenuClearOf(menu, new DOMRect(x, y, 0, 0));
    menuDismiss.arm();
    lockPageScroll();
  }

  /** The live selection Range, but only when it actually sits inside the document. */
  function currentRange(): Range | undefined {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      return undefined;
    }
    const range = sel.getRangeAt(0);
    return content.contains(range.commonAncestorContainer) ? range : undefined;
  }

  /**
   * US-23.1 AC1: the click-resolved caret Range at (x, y), or null when
   * nothing addressable sits there (no `caretRangeFromPoint` support — every
   * VS Code webview is Chromium-based so it always has it — or the point maps
   * outside the document, e.g. an image/mermaid/table-chrome node with no
   * text position).
   */
  function caretRangeAt(x: number, y: number): Range | null {
    const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
    return typeof doc.caretRangeFromPoint === 'function' ? doc.caretRangeFromPoint(x, y) : null;
  }

  /**
   * Whether (node, offset) sits inside `range` — a Range containment check,
   * never the selection's bounding rect (a wrapped-line dead zone or an
   * indentation-column click must resolve consistently either way).
   */
  function pointInsideRange(range: Range, node: Node, offset: number): boolean {
    try {
      return range.comparePoint(node, offset) === 0;
    } catch {
      return false;
    }
  }

  /** Real pointer coordinates captured at the last `contextmenu`, or undefined for a keyboard-invoked one (AC1). */
  interface ContextClick {
    x: number;
    y: number;
  }
  let lastContextClick: ContextClick | undefined;

  /**
   * US-23.1 AC1: the Range "Add Comment" anchors to for `click` — a click
   * INSIDE the live selection keeps that selection (no collapse); a click
   * OUTSIDE it collapses to the click point; no click info at all (a
   * keyboard-invoked menu, or nothing left to consume) always keeps the live
   * selection untouched. Read-only — the actual collapse is a side effect of
   * which Range this returns, never a `window.getSelection()` mutation, so
   * calling this to decide the menu's enabled state costs nothing.
   */
  function resolveEffectiveRange(click: ContextClick | undefined): Range | undefined {
    const selection = currentRange();
    if (!click) {
      return selection;
    }
    const caret = caretRangeAt(click.x, click.y);
    if (
      selection &&
      !selection.collapsed &&
      caret &&
      pointInsideRange(selection, caret.startContainer, caret.startOffset)
    ) {
      return selection;
    }
    return caret ?? undefined;
  }

  content.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const range = currentRange();
    // A real mouse right-click reports `button === 2`; a keyboard-invoked
    // context menu (Shift+F10 / the Menu key) reports `button === 0` with no
    // meaningful click point in Chromium (every VS Code webview) — never
    // collapse an existing selection for one of those (AC1).
    lastContextClick = e.button === 2 ? { x: e.clientX, y: e.clientY } : undefined;
    const effective = resolveEffectiveRange(lastContextClick);
    const node = effective ? resolveCommentAnchorNode(content, effective) : null;
    openMenuAt(e.clientX, e.clientY, node !== null, range !== undefined && !range.collapsed);
  });

  // --- Composer ----------------------------------------------------------------------------

  const card = el('div', COMMENT_COMPOSER_CLASS);
  card.hidden = true;

  const header = el('div', 'comment-composer-header');
  const targetEl = el('span', 'comment-composer-target');
  header.append(bubbleIcon('comment-composer-icon'), el('span', 'comment-composer-title', 'New comment'), targetEl);

  const quoteEl = el('div', 'comment-composer-quote');
  const quoteText = el('div', 'comment-composer-quote-text');
  quoteEl.append(el('div', 'comment-composer-quote-rule'), quoteText);

  const authorRow = el('div', 'comment-composer-author');
  const avatar = el('span', 'comment-composer-avatar');
  const authorLabel = el('span', 'comment-composer-author-name');
  authorRow.append(avatar, authorLabel, el('span', 'comment-composer-author-note', 'will be recorded as the author'));

  const input = document.createElement('textarea');
  input.className = COMMENT_COMPOSER_INPUT_CLASS;
  input.rows = 3;
  input.placeholder = 'Comment text — required';
  input.setAttribute('aria-label', 'Comment text');

  // US-23.10 AC5: refusal reason shown INLINE (never a toast), with a
  // re-target affordance offered only for a stale/unresolvable-anchor refusal.
  const errorBox = el('div', 'comment-composer-error');
  errorBox.hidden = true;
  errorBox.setAttribute('role', 'alert');
  const errorText = el('span', 'comment-composer-error-text');
  const retargetBtn = el('button', 'comment-composer-retarget', 'Use current selection');
  retargetBtn.type = 'button';
  retargetBtn.hidden = true;
  errorBox.append(errorText, retargetBtn);

  const footer = el('div', 'comment-composer-footer');
  const hint = el('div', 'comment-composer-hint');
  const cancelBtn = el('button', 'comment-composer-btn comment-composer-cancel', 'Cancel');
  cancelBtn.type = 'button';
  const submitBtn = el('button', 'comment-composer-btn comment-composer-submit', 'Submit');
  submitBtn.type = 'button';
  const actions = el('div', 'comment-composer-actions');
  actions.append(cancelBtn, submitBtn);
  footer.append(hint, actions);

  card.append(header, quoteEl, authorRow, input, errorBox, footer);
  document.body.appendChild(card);

  /**
   * US-23.10 AC5: whether "That location changed…"/"lost its anchor…" — the
   * exact refusal strings `submit`'s own pre-check and the host's
   * `createCommentRejection` both use — is what came back, i.e. the refusal
   * this AC calls out for a re-target offer specifically. A heuristic tied to
   * those known strings rather than a new wire field, since every other
   * refusal (document guard, empty body, sidecar write failure) has nothing
   * useful to re-target.
   */
  function isAnchorRefusal(message: string): boolean {
    return message.includes('anchor') || message.includes('location');
  }

  function showInlineError(message: string, offerRetarget: boolean): void {
    errorText.textContent = message;
    errorBox.hidden = false;
    retargetBtn.hidden = !offerRetarget;
  }

  function clearInlineError(): void {
    errorBox.hidden = true;
    errorText.textContent = '';
    retargetBtn.hidden = true;
  }

  const composerDismiss = initPopoverDismiss(card, () => {
    pending?.node.classList.remove(COMMENT_ANCHOR_ACTIVE_CLASS);
    pending = undefined;
    input.value = '';
    clearInlineError();
    submitBusy = false;
    targetLost = false;
    input.readOnly = false;
  });

  const EMPTY_HINT = 'Submit stays inactive until text is entered';
  const BUSY_HINT = 'Submitting…';
  const TARGET_LOST_HINT = 'Re-select a target to submit · Esc to cancel';
  /** US-23.10 AC5: while a create is in flight, the input is read-only and Submit inert — never after a refusal, which re-arms both. */
  let submitBusy = false;
  /**
   * Req 24 US-23.18 AC7: the composer's anchor stopped resolving in the live DOM
   * (an undo/redo, or any other host `update`, re-rendered `#content` underneath
   * it). Submit is refused while this is set — the typed body is kept and the
   * card stays open so the Reviewer can re-target rather than lose it.
   */
  let targetLost = false;

  function syncSubmitState(): void {
    const ready = !submitBusy && !targetLost && input.value.trim() !== '';
    // aria-disabled, not `disabled`: the button stays focusable so a Reviewer
    // tabbing to it still reads why it is inert (design C4 — pressing it before
    // then does nothing and the card stays open, there is no error to recover from).
    submitBtn.setAttribute('aria-disabled', String(!ready));
    hint.textContent = submitBusy
      ? BUSY_HINT
      : targetLost
        ? TARGET_LOST_HINT
        : ready
          ? `${mod}⏎ to submit · Esc to cancel`
          : EMPTY_HINT;
  }

  /** The anchor for `range`/`node`, or null when the selection cannot be measured within `node` (US-23.1 AC3). */
  function mintAnchor(range: Range, node: HTMLElement): PendingAnchor | null {
    const offsetStart = getOffsetWithin(node, range.startContainer, range.startOffset);
    const offsetEnd = getOffsetWithin(node, range.endContainer, range.endOffset);
    if (offsetStart === null || offsetEnd === null) {
      return null;
    }
    return {
      node,
      anchorId: ensureCommentAnchorId(content, node),
      offsetStart,
      offsetEnd,
      line: commentAnchorLine(content, node),
      quote: range.toString(),
      recordedText: node.textContent ?? '',
      nearestHeading: nearestHeadingBefore(content, node),
    };
  }

  /** Refresh the composer's target/quote/author display from `anchor` — shared by `openComposer` and the AC5 re-target action. */
  function applyPendingToComposer(anchor: PendingAnchor): void {
    const onSelection = anchor.quote !== '';
    const what = onSelection ? 'on selection' : `on ${anchor.node.tagName.toLowerCase()}`;
    targetEl.textContent = anchor.line > 0 ? `${what} · Ln ${anchor.line}` : what;
    quoteEl.hidden = !onSelection;
    quoteText.textContent = onSelection ? `“${anchor.quote}”` : '';
    authorLabel.textContent = authorName;
    avatar.textContent = (authorName[0] ?? '?').toUpperCase();
  }

  /**
   * Mint the anchor for the live selection/caret and open the composer over it.
   * A no-op (with the reason surfaced) when there is no addressable node or a
   * create is already in flight — never a silently dropped action.
   */
  function openComposer(): void {
    if (inFlightRequestId !== undefined) {
      return; // US-23.1 dedup guard: one action, one thread.
    }
    // US-23.1 AC1: the collapse-to-click-point decision is applied HERE, at
    // invoke, never at menu-open — `lastContextClick` is consumed once.
    const click = lastContextClick;
    lastContextClick = undefined;
    const range = resolveEffectiveRange(click);
    const node = range ? resolveCommentAnchorNode(content, range) : null;
    const minted = range && node ? mintAnchor(range, node) : null;
    if (!range || !node || !minted) {
      showToast('No commentable block under the cursor.');
      return;
    }
    // US-23.1 AC1: "the caret is collapsed to the click point (and the stale
    // selection discarded)" — a pointer-originated click must actually replace
    // the live browser selection with the resolved range, not just compute one
    // internally, so a later re-target ("Use current selection") reads the
    // point the Reviewer clicked rather than whatever was selected before.
    // Skipped for a keyboard-invoked menu (`click` undefined) — that path must
    // never touch the selection at all.
    if (click) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range.cloneRange());
    }
    pending = minted;
    applyPendingToComposer(minted);
    input.value = '';
    clearInlineError();
    submitBusy = false;
    targetLost = false;
    input.readOnly = false;
    syncSubmitState();

    node.classList.add(COMMENT_ANCHOR_ACTIVE_CLASS);
    card.hidden = false;
    positionNear(card, range.getBoundingClientRect());
    composerDismiss.arm();
    input.focus();
  }

  function submit(): void {
    const body = input.value.trim();
    // Empty (or whitespace-only) is a no-op: the input stays open rather than
    // creating an empty thread — "refuse rather than store malformed data".
    // `targetLost` (US-23.18 AC7) refuses here too, not only through the anchor
    // lookup below: the button is `aria-disabled`, never `disabled`, so it stays
    // focusable and a keyboard/programmatic activation still reaches this.
    if (body === '' || !pending || targetLost || inFlightRequestId !== undefined) {
      return;
    }
    // The anchored node can be gone by now (a host 'update' re-rendered the
    // document under the open composer). Creating a thread against an id that
    // no longer resolves would leave it pointing at nothing (US-23.10 AC5: the
    // composer stays open, body intact, with a re-target offer — never a toast).
    if (!findCommentAnchor(content, pending.anchorId)) {
      showInlineError('That location changed — use your current selection to retry.', true);
      syncSubmitState();
      return;
    }
    clearInlineError();
    const requestId = ++requestSeq;
    inFlightRequestId = requestId;
    submitBusy = true;
    input.readOnly = true;
    syncSubmitState();
    // US-23.10 AC9: neutralize bidi/control characters and reconcile CRLF to
    // LF before the body ever leaves the webview, so every later surface
    // (gutter, tab, popover, the native `vscode.comments` UI) renders the same
    // already-clean text without re-applying this itself.
    // EOL must normalize FIRST: neutralizeBodyText's control-char strip also
    // removes a lone CR, so the composed order applied here would fuse a
    // CR-only line break into a run-on line before normalizeBodyEol ever saw it.
    const cleanBody = neutralizeBodyText(normalizeBodyEol(body));
    // US-23.4: the thread's handle for later anchor updates. Minted here because
    // the webview is the side that re-resolves the anchor and therefore the side
    // that has to name the thread it is talking about. It must be unique across
    // the whole extension host, not just this webview: one CommentController
    // serves every open document, so a bare per-webview counter would give the
    // first thread of every file — and of every reopened file — the same handle,
    // and an update for one document would move another document's thread.
    const seed: PendingSeed = {
      threadId: `${docUri}#${sessionSalt}-${requestId}`,
      body: cleanBody,
      anchorId: pending.anchorId,
      offsetStart: pending.offsetStart,
      offsetEnd: pending.offsetEnd,
      recordedText: pending.recordedText,
      lastKnownLine: pending.line,
      nearestHeading: pending.nearestHeading,
    };
    inFlightSeed = seed;
    vscode.postMessage({
      type: 'createComment',
      requestId,
      docUri,
      threadId: seed.threadId,
      anchorId: pending.anchorId,
      offsetStart: pending.offsetStart,
      offsetEnd: pending.offsetEnd,
      line: pending.line,
      body: cleanBody,
      recordedText: pending.recordedText,
      nearestHeading: pending.nearestHeading,
    });
    // US-23.10 AC5: stays open until the result arrives — closing here (the
    // old behavior) lost the typed body the instant a refusal came back, since
    // the dismiss callback above clears it.
  }

  input.addEventListener('input', syncSubmitState);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  });
  cancelBtn.addEventListener('click', () => composerDismiss.close());
  submitBtn.addEventListener('mousedown', (e) => e.preventDefault());
  submitBtn.addEventListener('click', submit);
  // US-23.10 AC5: re-target to whatever is selected/caretted RIGHT NOW,
  // keeping the typed body intact — offered only after a stale-anchor refusal.
  retargetBtn.addEventListener('mousedown', (e) => e.preventDefault());
  retargetBtn.addEventListener('click', () => {
    const range = currentRange();
    const node = range ? resolveCommentAnchorNode(content, range) : null;
    const minted = range && node ? mintAnchor(range, node) : null;
    if (!minted) {
      // Nothing to retarget to right now — leave the reason showing.
      return;
    }
    pending?.node.classList.remove(COMMENT_ANCHOR_ACTIVE_CLASS);
    pending = minted;
    minted.node.classList.add(COMMENT_ANCHOR_ACTIVE_CLASS);
    applyPendingToComposer(minted);
    clearInlineError();
    // Req 24 US-23.18 AC7: a fresh anchor is exactly the recovery this state
    // was holding Submit for — re-arm it.
    targetLost = false;
    syncSubmitState();
  });

  /**
   * Req 24 US-23.18 AC7. The anchor id is a session-only DOM attribute, so a
   * full re-render always drops it — which is exactly the condition `submit`'s
   * own shipped pre-check already refuses on (US-23.10 AC5). Nothing about WHEN
   * the create is refused changes here; this only moves the telling forward, so
   * the Reviewer sees "target lost" and can re-target instead of typing on
   * against a Submit that was already going to be refused.
   *
   * An in-flight create is left alone: its result decides, and `pending` is
   * still the anchor that request was sent with.
   */
  function syncTargetState(): void {
    if (card.hidden || submitBusy || pending === undefined) {
      return;
    }
    const lost = findCommentAnchor(content, pending.anchorId) === null;
    if (lost === targetLost) {
      return;
    }
    targetLost = lost;
    if (lost) {
      showInlineError(
        'Target lost — the text this comment was anchored to is no longer in the document. Use your current selection to retry.',
        true
      );
    } else {
      clearInlineError();
    }
    syncSubmitState();
  }

  return {
    refreshTarget: syncTargetState,
    notifyCreateResult(requestId, ok, error, author, timestamp): void {
      if (requestId !== inFlightRequestId) {
        return;
      }
      inFlightRequestId = undefined;
      const seed = inFlightSeed;
      inFlightSeed = undefined;
      submitBusy = false;
      input.readOnly = false;
      if (!ok) {
        const message = error ?? 'The comment could not be created.';
        if (card.hidden) {
          // The composer was already dismissed (outside click / Escape) while
          // this request was in flight — there is no inline surface left to
          // show the reason on, so fall back to a toast rather than writing
          // into a hidden element nobody sees (US-23.10 AC5: never silent).
          showToast(message);
          return;
        }
        // US-23.10 AC5: the composer stays open with the body intact and the
        // reason shown inline — never a toast, never a silent close.
        showInlineError(message, isAnchorRefusal(message));
        syncSubmitState();
        // Req 24 US-23.18 AC7: a render can have landed WHILE this create was in
        // flight, and `syncTargetState` declines to act during one. Re-check now
        // that the guard is released — otherwise the composer re-arms Submit
        // against an anchor that is already gone, which is the "refused after
        // pressing" behaviour AC7 exists to remove.
        syncTargetState();
        return;
      }
      clearInlineError();
      // US-23.4: only a thread the host actually created gets tracked — a
      // refused request must leave nothing behind to re-resolve. The author and
      // timestamp come from the reply, not from the composer's display hint:
      // the host re-reads the author setting at create time and that is what the
      // thread was actually filed under.
      if (seed) {
        // A freshly created thread is always Open with no replies yet (US-23.2/23.3).
        resolve.register({
          ...seed,
          author: author ?? authorName,
          createdAt: timestamp ?? '',
          status: 'Open',
          replies: [],
          statusChanges: [],
        });
      }
      // Only NOW, on success — closing at submit-time (the old behavior) lost
      // the composer's content the instant a refusal came back.
      composerDismiss.close();
    },
    setDocumentGuard(reason): void {
      documentGuardReason = reason;
    },
    setDocUri(uri): void {
      docUri = uri;
    },
    setAuthorName(name): void {
      authorName = name;
    },
  };
}
