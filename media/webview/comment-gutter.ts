/**
 * Req 23 US-23.2: gutter pins — a small marker in the left margin per line
 * carrying an Open/Resolved thread, always visible regardless of the "Show
 * Comments" toggle (that toggle only gates the inline highlight overlay,
 * comment-highlight.ts). Reads exclusively from comment-resolve.ts's registry
 * (`resolve.allThreads()`) — never recomputes anchor positions itself.
 *
 * Mounted on `document.body` (like comment-panel.ts), in its own reserved
 * lane immediately left of #content — independent of gutter.ts's numbered
 * line gutter (a separate lane, never shared DOM), and independent of the
 * `showLineNumbers` setting: comments show their pins regardless of it.
 *
 * A pin is scoped to the anchor's SOURCE LINE, not its horizontal position —
 * positioned from its carrier element's own `getBoundingClientRect().top`
 * (page-relative, `+ window.scrollY`), the same page-coordinate approach
 * gutter.ts's `scrollToText` already uses. Threads on nearby lines (within
 * `COMMENT_GUTTER_CLUSTER_BLANK_GAP` blank lines of each other) collapse into
 * one "+N" pin; a Closed thread renders no pin at all (design handoff).
 */
import type { AnchorState, CommentResolveController, ThreadAnchor } from './comment-resolve';
import {
  COMMENT_GUTTER_CLUSTER_BLANK_GAP,
  COMMENT_PIN_CLASS,
  COMMENT_PIN_CLUSTER_CLASS,
  COMMENT_PIN_NONEXACT_CLASS,
} from './constants';
import { el, positionNear } from './dom-utils';
import { initPopoverDismiss } from './escape-stack';
import { truncateDisplay } from './trigger-popup';

export interface CommentGutterController {
  /** Rebuild every pin from the resolver's current threads — call after a re-render or any resolve change. */
  refresh(): void;
}

const BUBBLE_PATH = 'M21 12a8 8 0 0 1-8 8H7l-4 3v-6.5A8 8 0 0 1 11 4h2a8 8 0 0 1 8 8z';

function bubbleIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'comment-gutter-pin-icon');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', BUBBLE_PATH);
  svg.appendChild(path);
  return svg;
}

/** 1-based source line a thread's pin binds to — the anchor's own last-known line, never its horizontal position. */
function threadLine(anchor: ThreadAnchor): number {
  return anchor.lastKnownLine;
}

/** Comments + replies under one thread — what the pin's badge counts (design handoff). */
function messageCount(anchor: ThreadAnchor): number {
  return 1 + anchor.replies.length;
}

/**
 * Req 24 US-23.8 AC2: the requirement's own wording for a single non-exact
 * thread; a cluster whose threads are ALL non-exact but disagree on tier gets
 * the more honest combined phrasing rather than picking one arbitrarily.
 */
function nonExactLabel(states: AnchorState[]): string {
  if (states.every((s) => s === 'floating')) {
    return 'Unresolved location';
  }
  if (states.every((s) => s === 'approximate')) {
    return 'Approximate location';
  }
  return 'Approximate or unresolved locations';
}

/** Consecutive-line clustering: a new group starts once the gap to the previous thread's line exceeds the blank-line window. */
export function buildGroups(anchors: ThreadAnchor[]): ThreadAnchor[][] {
  const sorted = anchors.slice().sort((a, b) => threadLine(a) - threadLine(b));
  const groups: ThreadAnchor[][] = [];
  for (const anchor of sorted) {
    const current = groups[groups.length - 1];
    // A non-positive line means "line unknown" (`commentAnchorLine` falls back to
    // 0 for a node with no source range yet), NOT "line 0". Grouping those by
    // value collapsed unrelated threads from opposite ends of the document into
    // one pin, leaving the others with no marker near their own text.
    const groupable =
      current !== undefined &&
      threadLine(anchor) > 0 &&
      threadLine(current[current.length - 1]) > 0 &&
      threadLine(anchor) - threadLine(current[current.length - 1]) <= COMMENT_GUTTER_CLUSTER_BLANK_GAP + 1;
    if (groupable) {
      current.push(anchor);
    } else {
      groups.push([anchor]);
    }
  }
  return groups;
}

export function initCommentGutter(
  content: HTMLElement,
  resolve: CommentResolveController,
  /** Open the single-thread popover — supplied by main.ts's wiring to comment-popover.ts. */
  openThread: (threadId: string, anchorRect: DOMRect) => void
): CommentGutterController {
  const layer = el('div', 'comment-gutter-layer');
  layer.id = 'comment-gutter';
  document.body.appendChild(layer);

  // Cluster/multi-thread-per-line chooser — a small list, single-open like
  // every other popover in this codebase.
  const list = el('div', 'comment-gutter-cluster-list');
  list.hidden = true;
  list.setAttribute('role', 'menu');
  document.body.appendChild(list);
  const listDismiss = initPopoverDismiss(list, () => {
    list.textContent = '';
  });

  function openChooser(anchors: ThreadAnchor[], anchorRect: DOMRect): void {
    list.textContent = '';
    for (const anchor of anchors) {
      const row = el('button', 'comment-gutter-cluster-row');
      row.type = 'button';
      row.setAttribute('role', 'menuitem');
      row.appendChild(el('span', 'comment-gutter-cluster-row-line', `Ln ${threadLine(anchor)}`));
      row.appendChild(
        el('span', 'comment-gutter-cluster-row-snippet', truncateDisplay(anchor.body.replace(/\s+/g, ' ').trim(), 48))
      );
      row.appendChild(el('span', `comment-gutter-cluster-row-status status-${anchor.status.toLowerCase()}`, anchor.status));
      // AC2: per-row, not just the cluster pin as a whole — a chooser listing
      // one exact and one approximate thread must not read as if both are exact.
      if (anchor.state !== 'exact') {
        row.appendChild(
          el('span', 'comment-gutter-cluster-row-nonexact', nonExactLabel([anchor.state]))
        );
      }
      row.addEventListener('click', () => {
        listDismiss.close();
        openThread(anchor.threadId, row.getBoundingClientRect());
      });
      list.appendChild(row);
    }
    list.hidden = false;
    positionNear(list, anchorRect);
    listDismiss.arm();
  }

  function renderPin(anchors: ThreadAnchor[]): HTMLElement {
    const allResolved = anchors.every((a) => a.status === 'Resolved');
    // Driven by THREAD count, not by distinct lines: two threads on the same line
    // are trivially inside the cluster window, and `activate()` already opens the
    // chooser for any multi-thread pin — gating the affordance on distinct lines
    // made a same-line pair look like a single-thread pin but behave clustered,
    // with a badge that conflated 2 threads × 1 reply with 1 thread × 3 replies.
    const isCluster = anchors.length > 1;
    // AC2: a cluster pin is marked non-exact only when EVERY thread in it is —
    // one exact thread sharing a line with an approximate one still resolves
    // exactly on click for the reader who picked it, so the pin itself must
    // not claim otherwise.
    const allNonExact = anchors.every((a) => a.state !== 'exact');
    const classes = [
      COMMENT_PIN_CLASS,
      isCluster ? COMMENT_PIN_CLUSTER_CLASS : '',
      allResolved ? 'resolved' : '',
      allNonExact ? COMMENT_PIN_NONEXACT_CLASS : '',
    ]
      .filter(Boolean)
      .join(' ');
    const pin = el('div', classes);
    pin.setAttribute('role', 'button');
    pin.tabIndex = 0;
    pin.appendChild(bubbleIcon());
    if (allNonExact) {
      // Shape cue, not colour alone: a small glyph badge, styled in editor.css.
      const badge = el('span', 'comment-gutter-pin-nonexact-badge', '~');
      badge.setAttribute('aria-hidden', 'true');
      pin.appendChild(badge);
    }
    const totalMessages = anchors.reduce((sum, a) => sum + messageCount(a), 0);
    pin.appendChild(el('span', 'comment-gutter-pin-count', isCluster ? `+${anchors.length}` : String(totalMessages)));
    const lines = Array.from(new Set(anchors.map(threadLine))).sort((a, b) => a - b);
    // A cluster describes THREADS (that is what picking one from the chooser
    // selects); a single pin describes the messages inside its one thread.
    const span = lines[0] === lines[lines.length - 1] ? `line ${lines[0]}` : `lines ${lines[0]}–${lines[lines.length - 1]}`;
    const nonExactSuffix = allNonExact ? ` · ${nonExactLabel(anchors.map((a) => a.state))}` : '';
    pin.title = isCluster
      ? `${anchors.length} comment threads on ${span}${nonExactSuffix}`
      : `${totalMessages} comment${totalMessages === 1 ? '' : 's'} · ${allResolved ? 'Resolved' : 'Open'}${nonExactSuffix}`;
    const activate = (): void => {
      if (anchors.length === 1) {
        openThread(anchors[0].threadId, pin.getBoundingClientRect());
      } else {
        openChooser(anchors, pin.getBoundingClientRect());
      }
    };
    pin.addEventListener('click', activate);
    pin.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
    return pin;
  }

  function positionPin(pin: HTMLElement, carrier: HTMLElement): void {
    const rect = carrier.getBoundingClientRect();
    pin.style.top = `${rect.top + window.scrollY}px`;
  }

  function refresh(): void {
    layer.textContent = '';
    const visible = resolve
      .allThreads()
      // A Closed thread drops off the gutter entirely (design handoff) — still
      // reachable through the not-yet-built Comment tab (US-23.7).
      .filter((a) => a.status !== 'Closed' && a.carrier?.isConnected);
    document.body.classList.toggle('comment-gutter-active', visible.length > 0);
    for (const group of buildGroups(visible)) {
      const representative = group[0].carrier;
      if (!representative) {
        continue;
      }
      const pin = renderPin(group);
      positionPin(pin, representative);
      layer.appendChild(pin);
    }
  }

  resolve.onChange(refresh);

  // Pin positions depend on layout (font size, column width, wrapping) rather
  // than scroll (absolute-positioned in page coordinates, like #line-gutter),
  // so only a layout change need trigger a rebuild — rAF-coalesced per the
  // hot-handler rule, mirroring gutter.ts's own ResizeObserver.
  let rafPending: number | undefined;
  new ResizeObserver(() => {
    if (rafPending !== undefined) {
      return;
    }
    rafPending = requestAnimationFrame(() => {
      rafPending = undefined;
      refresh();
    });
  }).observe(content);

  return { refresh };
}
