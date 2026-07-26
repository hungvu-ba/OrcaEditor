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
import { el, getOffsetWithin, positionNear, showToast } from './dom-utils';
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

/** Everything about a thread the webview knows BEFORE the host confirms it. */
type PendingSeed = Omit<ThreadAnchorSeed, 'author' | 'createdAt'>;

/** Marks the anchored node while the composer is open, so it is obvious what the comment attaches to. */
const ANCHOR_ACTIVE_CLASS = 'comment-anchor-active';

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
    setItemDisabled(addCommentItem, !anchorable, 'No commentable block under the cursor');
    setItemDisabled(cutItem, !hasSelection, 'Nothing selected');
    setItemDisabled(copyItem, !hasSelection, 'Nothing selected');
    menu.hidden = false;
    positionMenuClearOf(menu, new DOMRect(x, y, 0, 0));
    menuDismiss.arm();
    lockPageScroll();
  }

  content.addEventListener('contextmenu', (e) => {
    const range = currentRange();
    const node = range ? resolveCommentAnchorNode(content, range) : null;
    e.preventDefault();
    openMenuAt(e.clientX, e.clientY, node !== null, range !== undefined && !range.collapsed);
  });

  /** The live selection Range, but only when it actually sits inside the document. */
  function currentRange(): Range | undefined {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      return undefined;
    }
    const range = sel.getRangeAt(0);
    return content.contains(range.commonAncestorContainer) ? range : undefined;
  }

  // --- Composer ----------------------------------------------------------------------------

  const card = el('div', 'comment-composer');
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
  input.className = 'comment-composer-input';
  input.rows = 3;
  input.placeholder = 'Comment text — required';
  input.setAttribute('aria-label', 'Comment text');

  const footer = el('div', 'comment-composer-footer');
  const hint = el('div', 'comment-composer-hint');
  const cancelBtn = el('button', 'comment-composer-btn comment-composer-cancel', 'Cancel');
  cancelBtn.type = 'button';
  const submitBtn = el('button', 'comment-composer-btn comment-composer-submit', 'Submit');
  submitBtn.type = 'button';
  const actions = el('div', 'comment-composer-actions');
  actions.append(cancelBtn, submitBtn);
  footer.append(hint, actions);

  card.append(header, quoteEl, authorRow, input, footer);
  document.body.appendChild(card);

  const composerDismiss = initPopoverDismiss(card, () => {
    pending?.node.classList.remove(ANCHOR_ACTIVE_CLASS);
    pending = undefined;
    input.value = '';
  });

  const EMPTY_HINT = 'Submit stays inactive until text is entered';

  function syncSubmitState(): void {
    const ready = input.value.trim() !== '';
    // aria-disabled, not `disabled`: the button stays focusable so a Reviewer
    // tabbing to it still reads why it is inert (design C4 — pressing it before
    // then does nothing and the card stays open, there is no error to recover from).
    submitBtn.setAttribute('aria-disabled', String(!ready));
    hint.textContent = ready ? `${mod}⏎ to submit · Esc to cancel` : EMPTY_HINT;
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
    const range = currentRange();
    const node = range ? resolveCommentAnchorNode(content, range) : null;
    if (!range || !node) {
      showToast('No commentable block under the cursor.');
      return;
    }
    const offsetStart = getOffsetWithin(node, range.startContainer, range.startOffset);
    const offsetEnd = getOffsetWithin(node, range.endContainer, range.endOffset);
    if (offsetStart === null || offsetEnd === null) {
      showToast('Could not anchor a comment to that selection.');
      return;
    }
    const quote = range.toString();
    pending = {
      node,
      anchorId: ensureCommentAnchorId(content, node),
      offsetStart,
      offsetEnd,
      line: commentAnchorLine(content, node),
      quote,
      recordedText: node.textContent ?? '',
      nearestHeading: nearestHeadingBefore(content, node),
    };

    const onSelection = quote !== '';
    const what = onSelection ? 'on selection' : `on ${node.tagName.toLowerCase()}`;
    targetEl.textContent = pending.line > 0 ? `${what} · Ln ${pending.line}` : what;
    quoteEl.hidden = !onSelection;
    quoteText.textContent = onSelection ? `“${quote}”` : '';
    authorLabel.textContent = authorName;
    avatar.textContent = (authorName[0] ?? '?').toUpperCase();
    input.value = '';
    syncSubmitState();

    node.classList.add(ANCHOR_ACTIVE_CLASS);
    card.hidden = false;
    positionNear(card, range.getBoundingClientRect());
    composerDismiss.arm();
    input.focus();
  }

  function submit(): void {
    const body = input.value.trim();
    // Empty (or whitespace-only) is a no-op: the input stays open rather than
    // creating an empty thread — "refuse rather than store malformed data".
    if (body === '' || !pending || inFlightRequestId !== undefined) {
      return;
    }
    // The anchored node can be gone by now (a host 'update' re-rendered the
    // document under the open composer). Creating a thread against an id that
    // no longer resolves would leave it pointing at nothing.
    if (!findCommentAnchor(content, pending.anchorId)) {
      showToast('That location changed — the comment was not created.');
      composerDismiss.close();
      return;
    }
    const requestId = ++requestSeq;
    inFlightRequestId = requestId;
    // US-23.4: the thread's handle for later anchor updates. Minted here because
    // the webview is the side that re-resolves the anchor and therefore the side
    // that has to name the thread it is talking about. It must be unique across
    // the whole extension host, not just this webview: one CommentController
    // serves every open document, so a bare per-webview counter would give the
    // first thread of every file — and of every reopened file — the same handle,
    // and an update for one document would move another document's thread.
    const seed: PendingSeed = {
      threadId: `${docUri}#${sessionSalt}-${requestId}`,
      body,
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
      body,
      recordedText: pending.recordedText,
      nearestHeading: pending.nearestHeading,
    });
    composerDismiss.close();
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

  return {
    notifyCreateResult(requestId, ok, error, author, timestamp): void {
      if (requestId !== inFlightRequestId) {
        return;
      }
      inFlightRequestId = undefined;
      const seed = inFlightSeed;
      inFlightSeed = undefined;
      if (!ok) {
        showToast(error ?? 'The comment could not be created.');
        return;
      }
      // US-23.4: only a thread the host actually created gets tracked — a
      // refused request must leave nothing behind to re-resolve. The author and
      // timestamp come from the reply, not from the composer's display hint:
      // the host re-reads the author setting at create time and that is what the
      // thread was actually filed under.
      if (seed) {
        resolve.register({ ...seed, author: author ?? authorName, createdAt: timestamp ?? '' });
      }
    },
    setDocUri(uri): void {
      docUri = uri;
    },
    setAuthorName(name): void {
      authorName = name;
    },
  };
}
