/**
 * Broken-reference detection + always-visible inline marker + hover tooltip
 * (Req 20 US-20.9 / Req 21 US-21.3's shared marker language) — FILE links,
 * same-document HEADING links, and ENTITY references (Req 21 US-21.3, id-checked
 * via the host's `checkEntitiesExist`, with a "+N other occurrences — Fix all"
 * tooltip line backed by the session occurrence cache).
 *
 * Hooked into `main.ts`'s `renderDocument()`/`refresh()` chain via `refresh()`.
 * Marker DOM stays a single class on the existing `<a>` (icon painted with a
 * CSS `::before` mask, see `editor.css` `.broken-ref`) — no extra child nodes
 * inside `#content`, so turndown's default `<a>` serialization is completely
 * unaffected (a DOM-node marker, e.g. a wrapping `<span>`+`<svg>`, would leak
 * into the round-tripped Markdown; a class does not).
 *
 * Live-check discipline: debounced recompute, a monotonic `docVersion` +
 * `requestId` pair stamps every host round trip (mirrors trigger-popup.ts's
 * position-validity guard) so a late `targetsExistResult` from a superseded
 * scan is discarded; read-only (never edits the document); the reference the
 * caret is currently inside is skipped for that pass; `http(s)`/other
 * absolute-scheme hrefs are never sent to the host.
 */
import { BROKEN_REF_RECOMPUTE_DEBOUNCE_MS, BROKEN_REF_TOOLTIP_HIDE_GRACE_MS } from './constants';
import { el, positionNear, warningTriangleIcon } from './dom-utils';
import { ENTITY_REF_CLASS } from './render';
import type { VsCodeApi } from './vscode-api';
import type { EntityExistResult, TargetExistsResult } from '../../src/shared/messages';

/** Class stamped on a broken file/heading link's `<a>` — see `.broken-ref` (editor.css) for the marker treatment. */
export const BROKEN_REF_CLASS = 'broken-ref';

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';

/**
 * Same slugify rule `main.ts`'s `scrollToAnchor` uses to resolve a `#heading`
 * link against the rendered heading text — the ONE source of truth for both
 * (main.ts imports this instead of re-deriving its own copy).
 */
export function slugifyHeadingText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '');
}

/** True for any href with a URL scheme (`http:`, `https:`, `mailto:`, ...) — never checked, per the Broken Reference plan. */
function hasUrlScheme(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

/**
 * Width of the warning-triangle hover hitzone at a broken-ref anchor's start —
 * the `::before` marker is a 12px icon + 3px gap (markdown.css), so the fix
 * popup only opens while the pointer is within this leading strip. Hovering the
 * link TEXT instead surfaces entity-scope.ts's plain info tooltip.
 */
const BROKEN_TRIANGLE_HITZONE_PX = 16;

/** True when (clientX, clientY) sits over a broken-ref anchor's leading warning-triangle marker (first line box only). */
export function pointerOverBrokenTriangle(anchor: Element, clientX: number, clientY: number): boolean {
  const r = anchor.getClientRects()[0]; // triangle sits at the start of the FIRST line box even when the anchor wraps.
  if (!r) {
    return false;
  }
  return clientY >= r.top && clientY <= r.bottom && clientX >= r.left && clientX <= r.left + BROKEN_TRIANGLE_HITZONE_PX;
}

export interface BrokenRefDeps {
  content: HTMLElement;
  vscode: VsCodeApi;
  /** Invoked when the "Search again →" tooltip action is picked for a broken file/heading/entity anchor. */
  onSearchAgain(anchor: HTMLAnchorElement): void;
  /** Req 21 US-21.3: invoked when the tooltip's "Fix all" line is picked for a broken entity anchor with other occurrences. */
  onFixAll(anchor: HTMLAnchorElement): void;
  /** Invoked after every recompute pass — Req 21 US-21.3's toolbar badge recomputes its count/list from `list()` here. */
  onChange?(): void;
}

export interface BrokenRefController {
  /** Re-scan `#content` for broken references — call after any DOM rebuild (renderDocument) or edit. Debounced internally. */
  refresh(): void;
  /** Message-handler hook: forward a `targetsExistResult` reply here. */
  notifyResult(requestId: number, docVersion: number, results: TargetExistsResult[]): void;
  /** Message-handler hook: forward an `entitiesExistResult` reply here (Req 21 US-21.3). */
  notifyEntitiesResult(requestId: number, docVersion: number, results: EntityExistResult[]): void;
  /** Currently-marked broken-reference anchors, in document order (US-21.3's toolbar badge). */
  list(): HTMLAnchorElement[];
}

export function initBrokenRef(deps: BrokenRefDeps): BrokenRefController {
  const { content, vscode, onSearchAgain, onFixAll, onChange } = deps;

  // ---- Hover tooltip (rich: title/description/divider/action — NOT tooltip.ts's plain-text one) ----
  const tooltip = el('div', 'broken-ref-tooltip');
  tooltip.hidden = true;
  const titleRow = el('div', 'broken-ref-tooltip-title');
  titleRow.innerHTML = warningTriangleIcon(13);
  const titleText = document.createElement('span');
  titleRow.appendChild(titleText);
  const descRow = el('div', 'broken-ref-tooltip-desc');
  const divider = el('div', 'broken-ref-tooltip-divider');
  const actionRow = el('a', 'broken-ref-tooltip-action', 'Search again →');
  actionRow.href = '#';
  // Req 21 US-21.3: extra "Fix all" line — only shown for a broken entity ref
  // whose session-cache occurrence count is >1 (text set live per hover).
  const fixAllRow = el('a', 'broken-ref-tooltip-fixall');
  fixAllRow.href = '#';
  fixAllRow.hidden = true;
  tooltip.append(titleRow, descRow, divider, actionRow, fixAllRow);
  document.body.appendChild(tooltip);

  let tooltipAnchor: HTMLAnchorElement | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  function cancelHide(): void {
    if (hideTimer !== undefined) {
      clearTimeout(hideTimer);
      hideTimer = undefined;
    }
  }

  function hideTooltip(): void {
    cancelHide();
    tooltip.hidden = true;
    tooltipAnchor = undefined;
  }

  /**
   * Ẩn tooltip sau một khoảng ân hạn thay vì ngay lập tức, để chuột kịp băng qua
   * khe hở anchor↔tooltip mà bấm "Search again →" (tooltip's `mouseenter` hủy
   * timer). Ẩn-tức-thì khiến popup biến mất trước khi chuột chạm tới nó.
   */
  function scheduleHide(): void {
    cancelHide();
    hideTimer = setTimeout(hideTooltip, BROKEN_REF_TOOLTIP_HIDE_GRACE_MS);
  }

  function showTooltip(anchor: HTMLAnchorElement, title: string, description: string, showAction: boolean): void {
    cancelHide();
    tooltipAnchor = anchor;
    titleText.textContent = title;
    descRow.textContent = description;
    actionRow.hidden = !showAction;
    fixAllRow.hidden = true; // entity branch re-shows it below when there are other occurrences.
    tooltip.hidden = false;
    positionNear(tooltip, anchor.getBoundingClientRect());
  }

  actionRow.addEventListener('mousedown', (e) => e.preventDefault());
  actionRow.addEventListener('click', (e) => {
    e.preventDefault();
    if (tooltipAnchor) {
      onSearchAgain(tooltipAnchor);
    }
    hideTooltip();
  });

  fixAllRow.addEventListener('mousedown', (e) => e.preventDefault());
  fixAllRow.addEventListener('click', (e) => {
    e.preventDefault();
    if (tooltipAnchor) {
      onFixAll(tooltipAnchor);
    }
    hideTooltip();
  });

  /** Populate + open the fix popup for `anchor` per its broken-ref kind. */
  function showFor(anchor: HTMLAnchorElement): void {
    const kind = anchor.dataset.brokenRefKind;
    if (kind === 'entity') {
      const target = anchor.dataset.brokenRefTarget ?? '';
      showTooltip(anchor, `${target} not found`, 'The declaration may have been deleted, renamed, or its namespace changed.', true);
      // "+N other occurrence(s)" — N excludes the hovered occurrence itself.
      const n = Math.max(0, Number(anchor.dataset.brokenRefOccurrences ?? '0') - 1);
      if (n > 0) {
        fixAllRow.textContent = `+${n} other occurrence${n === 1 ? '' : 's'} found so far — Fix all`;
        fixAllRow.hidden = false;
      }
    } else if (kind === 'heading') {
      showTooltip(anchor, 'Heading not found', `#${anchor.dataset.brokenRefTarget ?? ''} may have been renamed or removed.`, false);
    } else {
      const target = anchor.dataset.brokenRefTarget ?? '';
      showTooltip(anchor, 'File not found', `${target} may have been moved, renamed, or deleted.`, true);
    }
  }

  // The fix popup opens only while the pointer is over the leading warning
  // triangle (not the link text — that region belongs to entity-scope.ts's
  // info tooltip). mousemove-driven (not mouseover) so crossing between the
  // triangle and the text WITHIN one anchor re-evaluates; rAF-coalesced per the
  // hot-handler layout-read discipline (getClientRects in pointerOverBrokenTriangle).
  let moveRaf = 0;
  let moveX = 0;
  let moveY = 0;
  let moveTarget: HTMLElement | null = null;
  content.addEventListener(
    'mousemove',
    (e) => {
      moveX = (e as MouseEvent).clientX;
      moveY = (e as MouseEvent).clientY;
      moveTarget = e.target as HTMLElement;
      if (moveRaf !== 0) {
        return;
      }
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        const anchor = moveTarget?.closest<HTMLAnchorElement>(`a.${BROKEN_REF_CLASS}`) ?? null;
        if (anchor && pointerOverBrokenTriangle(anchor, moveX, moveY)) {
          if (anchor === tooltipAnchor) {
            cancelHide(); // chuột quay lại chính tam giác đang mở popup → hủy lịch ẩn.
          } else {
            showFor(anchor);
          }
        } else if (tooltipAnchor && hideTimer === undefined) {
          scheduleHide(); // rời khỏi tam giác (sang text/ra ngoài) → hẹn ẩn (một lần, đủ ân hạn băng sang popup).
        }
      });
    },
    true
  );
  tooltip.addEventListener('mouseenter', cancelHide);
  tooltip.addEventListener('mouseleave', hideTooltip);
  // Content re-rendered / scrolled out from under the tooltip → its anchor rect is stale, drop it.
  document.addEventListener('scroll', hideTooltip, true);

  // ---- Detection ----
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let docVersion = 0;
  let requestSeq = 0;
  let latestRequestId = -1;
  const pendingByRequest = new Map<number, Map<string, HTMLAnchorElement[]>>();
  // Req 21 US-21.3: parallel state for the entity-existence batch (shares
  // requestSeq/docVersion with the file batch, own latest-id discard guard).
  let latestEntityRequestId = -1;
  const entityPendingByRequest = new Map<number, Map<string, HTMLAnchorElement[]>>();
  let currentMarked: HTMLAnchorElement[] = [];

  function caretInsideAnchor(anchor: Element): boolean {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.anchorNode) {
      return false;
    }
    return anchor.contains(sel.anchorNode);
  }

  function headingExists(fragment: string): boolean {
    if (!fragment) {
      return false;
    }
    const decoded = decodeURIComponent(fragment).toLowerCase();
    for (const heading of Array.from(content.querySelectorAll(HEADING_SELECTOR))) {
      if (slugifyHeadingText(heading.textContent ?? '') === decoded) {
        return true;
      }
    }
    return false;
  }

  function mark(anchor: HTMLAnchorElement, broken: boolean, kind: 'file' | 'heading' | 'entity', target: string): void {
    anchor.classList.toggle(BROKEN_REF_CLASS, broken);
    if (broken) {
      anchor.dataset.brokenRefKind = kind;
      anchor.dataset.brokenRefTarget = target;
    } else {
      delete anchor.dataset.brokenRefKind;
      delete anchor.dataset.brokenRefTarget;
      delete anchor.dataset.brokenRefOccurrences;
    }
  }

  function refreshMarkedList(): void {
    currentMarked = Array.from(content.querySelectorAll(`a.${BROKEN_REF_CLASS}`)) as HTMLAnchorElement[];
    onChange?.();
  }

  /**
   * Scan `#content`'s anchors; resolves heading-only targets locally, returns
   * file-link candidates (`fileByTarget`) + entity-reference candidates
   * (`entityByFullId`, keyed by full entity token) to batch-check via the host.
   */
  function collectCandidates(): {
    fileByTarget: Map<string, HTMLAnchorElement[]>;
    entityByFullId: Map<string, HTMLAnchorElement[]>;
  } {
    const fileByTarget = new Map<string, HTMLAnchorElement[]>();
    const entityByFullId = new Map<string, HTMLAnchorElement[]>();
    const anchors = Array.from(content.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') ?? '';
      if (!href || hasUrlScheme(href)) {
        mark(anchor, false, 'file', ''); // never a broken-ref target — clear any stale marker.
        continue;
      }
      if (caretInsideAnchor(anchor)) {
        continue; // skip the reference the caret is currently inside — leave its marker as-is this pass.
      }
      const hashIdx = href.indexOf('#');
      const filePart = hashIdx === -1 ? href : href.slice(0, hashIdx);
      const fragment = hashIdx === -1 ? '' : href.slice(hashIdx + 1);
      // Entity reference (stamped by postProcessEntityRefs): its `#fragment` is a
      // full entity token — id-checked via the host, NEVER the heading/file
      // branches below (a same-doc `#UC01` would otherwise mis-flag as a heading).
      if (anchor.classList.contains(ENTITY_REF_CLASS)) {
        if (!fragment) {
          mark(anchor, false, 'entity', ''); // malformed — clear any stale marker.
          continue;
        }
        const list = entityByFullId.get(fragment);
        if (list) {
          list.push(anchor);
        } else {
          entityByFullId.set(fragment, [anchor]);
        }
        continue;
      }
      if (!filePart) {
        // Pure "#heading" same-document anchor — resolved locally against the TOC heading index, no fs.stat round trip.
        mark(anchor, !headingExists(fragment), 'heading', fragment);
        continue;
      }
      // Cross-file `path.md#heading` — file-level existence only (per the Broken Reference plan §Sequencing).
      const list = fileByTarget.get(filePart);
      if (list) {
        list.push(anchor);
      } else {
        fileByTarget.set(filePart, [anchor]);
      }
    }
    return { fileByTarget, entityByFullId };
  }

  function recompute(): void {
    docVersion++;
    const { fileByTarget, entityByFullId } = collectCandidates();
    // Heading-only anchors above were already resolved synchronously — reflect
    // those now rather than waiting on the async batch replies below.
    refreshMarkedList();
    if (fileByTarget.size > 0) {
      const requestId = ++requestSeq;
      latestRequestId = requestId;
      pendingByRequest.set(requestId, fileByTarget);
      vscode.postMessage({
        type: 'checkTargetsExist',
        requestId,
        docVersion,
        targets: Array.from(fileByTarget.keys()),
      });
    } else {
      latestRequestId = -1;
    }
    if (entityByFullId.size > 0) {
      const requestId = ++requestSeq;
      latestEntityRequestId = requestId;
      entityPendingByRequest.set(requestId, entityByFullId);
      vscode.postMessage({
        type: 'checkEntitiesExist',
        requestId,
        docVersion,
        ids: Array.from(entityByFullId.keys()),
      });
    } else {
      latestEntityRequestId = -1;
    }
  }

  function notifyResult(requestId: number, _resultDocVersion: number, results: TargetExistsResult[]): void {
    const byTarget = pendingByRequest.get(requestId);
    pendingByRequest.delete(requestId);
    if (!byTarget || requestId !== latestRequestId) {
      return; // superseded by a newer scan — discard.
    }
    for (const { target, exists } of results) {
      for (const anchor of byTarget.get(target) ?? []) {
        if (content.contains(anchor)) {
          mark(anchor, !exists, 'file', target);
        }
      }
    }
    refreshMarkedList();
  }

  function notifyEntitiesResult(requestId: number, _resultDocVersion: number, results: EntityExistResult[]): void {
    const byFullId = entityPendingByRequest.get(requestId);
    entityPendingByRequest.delete(requestId);
    if (!byFullId || requestId !== latestEntityRequestId) {
      return; // superseded by a newer scan — discard.
    }
    for (const { id, exists, occurrences } of results) {
      for (const anchor of byFullId.get(id) ?? []) {
        if (content.contains(anchor)) {
          mark(anchor, !exists, 'entity', id);
          if (!exists) {
            anchor.dataset.brokenRefOccurrences = String(occurrences);
          }
        }
      }
    }
    refreshMarkedList();
  }

  function refresh(): void {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      recompute();
    }, BROKEN_REF_RECOMPUTE_DEBOUNCE_MS);
  }

  return {
    refresh,
    notifyResult,
    notifyEntitiesResult,
    list: () => currentMarked.filter((a) => content.contains(a)),
  };
}
