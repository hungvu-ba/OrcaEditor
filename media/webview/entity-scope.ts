/**
 * Req 21 US-21.3 — dot-notation scoped drill-down, `UC01.` right after a
 * resolved entity reference opens a popup scoped to that entity's own content
 * boundary (Headings + Captions declared within it), reusing the shared
 * trigger-popup.ts shell (Req 20 US-20.1's precedent — same shell, same
 * link-insertion behavior, no parallel popup implementation).
 *
 * CURRENT-DOCUMENT ONLY (T8.1 decision — see notes below): the boundary query
 * is a DOM mirror of entity-index.ts's "declaration -> end of section" rule,
 * operating on the webview's OWN rendered `#content` (block-map.ts / a second
 * file-local index was already rejected for the workspace-wide case in
 * US-21.3's brainstorming notes; drilling into one scope's own children is
 * different — it is inherently a same-document query, since the whole point
 * is "something nearby" in the document currently being edited). A reference
 * to an entity declared in ANOTHER file has no dot-drill/parent-context here —
 * the workspace-wide path is already covered by the Entities scope's namespace
 * browse (US-21.2, trigger-at.ts).
 *
 * Boundary-ambiguity decision (flagged 🔴 in the US-21.3 review, PO decision
 * TR.2 was "build against the AC as-is", not "resolve the ambiguity" — so this
 * is this task's own call, recorded in T8.1's `decisions`): the AC's literal
 * "ends at the next heading of same-or-higher level, OR the next caption::
 * declaration" would make the Captions group ALWAYS empty whenever a heading
 * separates a parent entity from its nested child (the child's own caption::
 * line is "the next caption:: declaration", so the literal rule stops the
 * scan one line too early to ever include it) — defeating the feature's own
 * purpose (UC01 -> "Business Rule" heading -> BR01 is the AC's own example).
 * The rule actually implemented here: a caption:: found BEFORE any heading has
 * been crossed since the anchor is a SIBLING (ends the scan, not a child); one
 * found AFTER at least one heading was crossed is a NESTED CHILD (collected,
 * scan continues). This reconciles the AC's own worked example with its
 * stated stopping rule.
 */
import { CAPTION_CLASS } from './render';
import { closestElement } from './dom-utils';
import { entityFollowingLabel, entityFollowingPreview, normalizeForSearch } from '../../src/text-utils';
import { runAtInsertLink } from './toolbar';
import { postProcessEntityRefs } from './dom-postprocess';
import { showTooltip, hideTooltip } from './tooltip';
import { BROKEN_REF_CLASS, pointerOverBrokenTriangle } from './broken-ref';
import type { TriggerPopupController, TriggerPopupGroup, TriggerPopupItem } from './trigger-popup';

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
/** Mirrors entity-index.ts's CAPTION_RE + NAMESPACE_RE validity rule, applied to a rendered badge's own text. */
const BADGE_TOKEN_RE = /^caption::(\p{L}+)(\S+)$/u;
/** Per-group cap (mirrors trigger-at.ts's own GROUP_CAP — a private per-module tuning value, not shared state). */
const GROUP_CAP = 8;

interface EntityToken {
  namespace: string;
  id: string;
}

function isHeadingEl(el: Element): boolean {
  return /^H[1-6]$/.test(el.tagName);
}

function headingLevelOf(el: Element): number {
  return Number(el.tagName[1]);
}

/** Parses a rendered `.md-caption` badge's own text (`caption::NS_ID`) — null if malformed (never happens for a badge postProcessCaptions itself created, but keeps this function total). */
function tokenOfBadge(badge: Element): EntityToken | null {
  const m = BADGE_TOKEN_RE.exec((badge.textContent ?? '').trim());
  return m ? { namespace: m[1], id: m[2] } : null;
}

/** Every heading + declared-entity badge in `content`, in document order — the shared spine both the boundary query and the parent-context lookup walk. */
function orderedAnchors(content: Element): Element[] {
  return Array.from(content.querySelectorAll(`${HEADING_SELECTOR}, .${CAPTION_CLASS}`));
}

/** Display label for a scope anchor (a heading's text, or an entity's full `namespace+id`). */
function anchorLabel(anchorEl: Element): string {
  if (isHeadingEl(anchorEl)) {
    return anchorEl.textContent ?? '';
  }
  const tok = tokenOfBadge(anchorEl);
  return tok ? `${tok.namespace}${tok.id}` : '';
}

export interface ScopedHeading {
  el: HTMLElement;
  text: string;
  level: number;
  /** Has at least one caption reachable within its own boundary — drives the "›" go-deeper affordance. */
  hasChildren: boolean;
  /** Dim breadcrumb — the heading path from the queried anchor down to (excluding) this heading. */
  breadcrumb: string;
}

export interface ScopedCaption extends EntityToken {
  el: HTMLElement;
  /** Dim breadcrumb — the heading path from the queried anchor down to this caption. */
  breadcrumb: string;
  /** Req 21: FULL following text (the entity's human name) — a mention inserts `NS_ID label`; '' when nothing follows. */
  label: string;
}

export interface EntityScopeResult {
  headings: ScopedHeading[];
  captions: ScopedCaption[];
}

/**
 * "Children of X" scoping query (US-21.3, third bullet — applies recursively
 * to any anchor, a declared entity OR a heading picked as an intermediate
 * scope). See this module's own doc comment for the boundary-ambiguity call.
 */
export function queryEntityScope(content: Element, anchorEl: Element): EntityScopeResult {
  const all = orderedAnchors(content);
  const startIdx = all.indexOf(anchorEl) + 1;
  if (startIdx === 0) {
    return { headings: [], captions: [] }; // anchorEl not found in content (stale/detached) — nothing to show.
  }
  const isHeadingAnchor = isHeadingEl(anchorEl);
  // A heading anchor's own level IS its close level (a same-or-higher heading ends its section);
  // an entity anchor's close level is whatever heading it itself sits under (0 = none, nothing closes it via the heading rule).
  const closeLevel = isHeadingAnchor
    ? headingLevelOf(anchorEl)
    : (() => {
        const idx = all.indexOf(anchorEl);
        for (let i = idx - 1; i >= 0; i--) {
          if (isHeadingEl(all[i])) return headingLevelOf(all[i]);
        }
        return 0;
      })();

  const label = anchorLabel(anchorEl);
  const headings: ScopedHeading[] = [];
  const captions: ScopedCaption[] = [];
  const crumbSoFar: string[] = [];
  let crossedHeading = false;

  for (let i = startIdx; i < all.length; i++) {
    const node = all[i];
    if (isHeadingEl(node)) {
      const level = headingLevelOf(node);
      if (level <= closeLevel) break; // same-or-higher-level heading — boundary ends here.
      headings.push({
        el: node as HTMLElement,
        text: node.textContent ?? '',
        level,
        hasChildren: false, // filled below, after the scan (needs the full sub-scope, not just this pass).
        breadcrumb: [label, ...crumbSoFar].join(' › '),
      });
      crumbSoFar.push(node.textContent ?? '');
      crossedHeading = true;
      continue;
    }
    const tok = tokenOfBadge(node);
    if (!tok) continue; // malformed badge — never actually happens, kept for totality.
    if (!isHeadingAnchor && !crossedHeading) {
      break; // a sibling entity at the SAME depth (no heading crossed yet) — ends this scope, not a child.
    }
    // The entity's human name is the text following the badge on its own line
    // (same source as the hover preview, but uncapped) — mirrors entity-index.ts.
    const captionLabel = entityFollowingLabel(node.nextSibling?.textContent ?? '');
    captions.push({ el: node as HTMLElement, ...tok, breadcrumb: [label, ...crumbSoFar].join(' › '), label: captionLabel });
  }

  for (const h of headings) {
    const sub = queryEntityScope(content, h.el);
    h.hasChildren = sub.captions.length > 0;
  }
  return { headings, captions };
}

/**
 * Parent-context hover lookup (US-21.3): the nearest declared entity whose
 * boundary (per this module's own rule above) encloses `badge` — a sibling
 * entity (no heading crossed since it) is transparent, walked past. Returns
 * null when `badge` has no enclosing entity (a top-level declaration).
 */
export function nearestEnclosingEntity(content: Element, badge: Element): EntityToken | null {
  const all = orderedAnchors(content);
  const idx = all.indexOf(badge);
  if (idx === -1) return null;
  let crossedHeading = false;
  for (let i = idx - 1; i >= 0; i--) {
    const node = all[i];
    if (isHeadingEl(node)) {
      crossedHeading = true;
      continue;
    }
    const tok = tokenOfBadge(node);
    if (!tok) continue;
    if (crossedHeading) return tok;
    // Sibling — transparent: keep walking back to find the shared ancestor (if any).
  }
  return null;
}

/** Decoded, display-friendly file name for a cross-file entity-ref href's file part (segment after the last `/`, percent-decoded; falls back to the raw part on a malformed sequence). */
function entityRefFileName(filePart: string): string {
  const base = filePart.slice(filePart.lastIndexOf('/') + 1) || filePart;
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

/** The rendered `.md-caption` badge declaring `namespace+id` in `content`, or null if not declared in THIS document. */
export function findCaptionBadge(content: Element, fullId: string): HTMLElement | null {
  const badges = Array.from(content.querySelectorAll(`.${CAPTION_CLASS}`)) as HTMLElement[];
  return badges.find((b) => tokenOfBadge(b) && `${tokenOfBadge(b)!.namespace}${tokenOfBadge(b)!.id}` === fullId) ?? null;
}

/**
 * Detects `.` typed immediately after a just-inserted entity-reference `<a>`
 * (US-21.3's `UC01.` trigger) via the `input` event — mirrors trigger-at.ts's
 * `detectMarkdownLinkTrigger`'s small, deliberately-not-shared pattern. Only
 * fires when the anchor's own token resolves to a declaration in THIS
 * document (see module doc comment — cross-file drill-down is out of scope).
 */
export function detectDotDrill(content: Element, ie: InputEvent): { badge: HTMLElement; range: Range } | null {
  if (ie.inputType !== 'insertText' || ie.data !== '.' || ie.isComposing) return null;
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  const elt = closestElement(r.startContainer);
  if (!elt || !content.contains(elt)) return null;
  const node = r.startContainer;
  const offset = r.startOffset;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.textContent ?? '';
  // The '.' must be the ONLY character typed so far in this fresh text node
  // (i.e. it sits right at this text node's start) — otherwise the caret
  // isn't immediately after the anchor, just somewhere later in running text.
  if (offset !== 1 || text[0] !== '.') return null;
  const prev = node.previousSibling;
  if (!prev || prev.nodeType !== Node.ELEMENT_NODE) return null;
  const prevEl = prev as Element;
  if (prevEl.tagName !== 'A') return null;
  const fullId = (prevEl.textContent ?? '').trim();
  const badge = findCaptionBadge(content, fullId);
  if (!badge) return null;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, offset);
  return { badge, range };
}

/** Diacritic-insensitive substring match on the visible text only (mirrors trigger-at.ts's matchesFilter). */
function matchesFilter(text: string, q: string): boolean {
  if (!q) return true;
  return normalizeForSearch(text).includes(normalizeForSearch(q));
}

export interface EntityScopeController {
  /** Wire on `content`'s 'input' listener (main.ts) — opens the drill popup when the dot-drill pattern is detected. */
  onInput(ie: InputEvent): void;
  /** Wire on `content`'s 'mousemove' (main.ts) — shows the parent-context tooltip on an entity-ref pill's TEXT, hides it over a broken pill's warning triangle (that region belongs to broken-ref.ts's fix popup). */
  onMouseMove(e: MouseEvent): void;
  /** Wire on `content`'s 'mouseout' (main.ts) — hides the tooltip when the pointer leaves the pill. */
  onMouseOut(e: MouseEvent): void;
}

export function initEntityScope(
  content: HTMLElement,
  popup: TriggerPopupController,
  /** Req 21 hover tooltip: cross-file preview lookup keyed by the href fragment (namespace+id); '' / undefined until the host reply lands. */
  previewById: (id: string) => string | undefined
): EntityScopeController {
  let scopeAnchor: HTMLElement | undefined;
  let deleteRange: Range | undefined;
  /** id → resolved commit target, rebuilt on every buildGroups() call (mirrors trigger-at.ts's targetsById). */
  let itemTargets = new Map<string, { kind: 'heading'; el: HTMLElement } | { kind: 'caption'; namespace: string; id: string; label: string }>();

  function buildGroups(q: string): TriggerPopupGroup[] {
    itemTargets = new Map();
    if (!scopeAnchor || !content.contains(scopeAnchor)) return [];
    const { headings, captions } = queryEntityScope(content, scopeAnchor);

    const shownHeadings = headings.filter((h) => matchesFilter(h.text, q)).slice(0, GROUP_CAP);
    const headingItems: TriggerPopupItem[] = shownHeadings.map((h, i) => {
      const id = `h:${i}`;
      itemTargets.set(id, { kind: 'heading', el: h.el });
      return { id, label: h.text, detail: h.breadcrumb, badge: h.hasChildren ? '›' : undefined };
    });

    const shownCaptions = captions.filter((c) => matchesFilter(`${c.namespace}${c.id}`, q)).slice(0, GROUP_CAP);
    const captionItems: TriggerPopupItem[] = shownCaptions.map((c, i) => {
      const id = `c:${i}`;
      itemTargets.set(id, { kind: 'caption', namespace: c.namespace, id: c.id, label: c.label });
      return { id, label: `${c.namespace}${c.id}`, detail: c.breadcrumb, tint: 'entity' };
    });

    const groups: TriggerPopupGroup[] = [];
    if (headingItems.length > 0) groups.push({ label: 'Headings', items: headingItems });
    if (captionItems.length > 0) groups.push({ label: 'Captions', items: captionItems });
    return groups;
  }

  function commitCaption(namespace: string, id: string, label: string): void {
    if (!deleteRange) return;
    const fullId = `${namespace}${id}`;
    // Req 21: display text = `NS_ID label` so the ref reads the entity's human
    // name; the href fragment stays the clean `#NS_ID`.
    runAtInsertLink(`#${fullId}`, label ? `${fullId} ${label}` : fullId, deleteRange);
    postProcessEntityRefs(content);
  }

  function drillInto(headingEl: HTMLElement): void {
    // Re-entrant: capture the range NOW — the shell's close() (right after
    // onPick fires) tears deleteRange-adjacent state via onClose below, same
    // close+reopen-via-queueMicrotask idiom trigger-at.ts's namespace-narrow
    // already uses for "pick advances to the next step" without a typed path.
    const captured = deleteRange?.cloneRange();
    if (!captured) return;
    queueMicrotask(() => {
      scopeAnchor = headingEl;
      deleteRange = captured;
      // Bug B1 — this reopen runs from inside the previous row's Enter handler;
      // guard so an IME double-Enter can't auto-commit/drill the reopened scope.
      openPopup(true);
    });
  }

  function openPopup(guardEnter = false): void {
    if (!deleteRange) return;
    popup.open({
      axis: '@',
      guardEnterUntilKeyup: guardEnter,
      anchorRange: deleteRange.cloneRange(),
      dataSource: { query: (q) => buildGroups(q) },
      onPick: (item) => {
        const target = itemTargets.get(item.id);
        if (!target) return;
        if (target.kind === 'heading') {
          drillInto(target.el);
        } else {
          commitCaption(target.namespace, target.id, target.label);
        }
      },
      onClose: () => {
        scopeAnchor = undefined;
        deleteRange = undefined;
      },
    });
  }

  function onInput(ie: InputEvent): void {
    if (popup.isOpen()) return; // a '.' while a popup is already open is an ordinary filter character.
    const match = detectDotDrill(content, ie);
    if (!match) return;
    scopeAnchor = match.badge;
    deleteRange = match.range;
    openPopup();
  }

  // ---- Parent-context hover tooltip (never inline/stored — recomputed live) ----
  let tooltipAnchor: Element | undefined;

  /**
   * Joins the tooltip parts, or null when there is nothing to add beyond the
   * mention text itself (a bare `id` with no preview/location is redundant with
   * what the pill already shows). Format: `id[ preview][ in location]`.
   */
  function composeTooltip(fullId: string, preview: string, location: string): string | null {
    if (!preview && !location) return null;
    const head = preview ? `${fullId} ${preview}` : fullId;
    return location ? `${head} in ${location}` : head;
  }

  /** The tooltip text for `anchor`, or null when there is nothing to show. */
  function resolveTooltipText(anchor: Element): string | null {
    const fullId = (anchor.textContent ?? '').trim();
    const href = anchor.getAttribute('href') ?? '';
    const hashIdx = href.indexOf('#');
    const filePart = hashIdx === -1 ? '' : href.slice(0, hashIdx);
    if (filePart) {
      // Cross-file mention (`file.md#UC01`): the declaration lives in another
      // file, so name that file; the preview (text following its `caption::`)
      // comes from the host, keyed by the raw href fragment (matches the id the
      // broken-ref scan sent) — '' until the host reply lands.
      const fragment = href.slice(hashIdx + 1);
      return composeTooltip(fullId, previewById(fragment) ?? '', entityRefFileName(filePart));
    }
    // Same-document mention (`#UC01`): preview from the declaration badge's own
    // following text node (postProcessCaptions inserts it right after the pill),
    // location = the nearest enclosing entity (none for a top-level declaration).
    const badge = findCaptionBadge(content, fullId);
    if (!badge) return null; // declared in another file — no same-document context (T8.1 scope limit).
    const preview = entityFollowingPreview(badge.nextSibling?.textContent ?? '');
    const parent = nearestEnclosingEntity(content, badge);
    return composeTooltip(fullId, preview, parent ? `${parent.namespace}${parent.id}` : '');
  }

  function clearTooltip(): void {
    if (tooltipAnchor) {
      tooltipAnchor = undefined;
      hideTooltip();
    }
  }

  // Info tooltip on the pill TEXT. mousemove-driven (not mouseover) so that on a
  // BROKEN pill the tooltip yields the leading warning-triangle region to
  // broken-ref.ts's fix popup, then re-appears when the pointer returns to the
  // text. rAF-coalesced per the hot-handler layout-read discipline
  // (pointerOverBrokenTriangle reads getClientRects); the heavy scope query runs
  // only on a transition to a NEW pill (anchor === tooltipAnchor short-circuits).
  let moveRaf = 0;
  let moveX = 0;
  let moveY = 0;
  let moveTarget: HTMLElement | null = null;
  function onMouseMove(e: MouseEvent): void {
    moveX = e.clientX;
    moveY = e.clientY;
    moveTarget = e.target as HTMLElement;
    if (moveRaf !== 0) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      const anchor = moveTarget?.closest('a.md-entity-ref') ?? null;
      if (!anchor || !content.contains(anchor)) {
        clearTooltip();
        return;
      }
      // Over a broken pill's warning triangle → that region belongs to the fix popup.
      if (anchor.classList.contains(BROKEN_REF_CLASS) && pointerOverBrokenTriangle(anchor, moveX, moveY)) {
        clearTooltip();
        return;
      }
      if (anchor === tooltipAnchor) return; // already resolved + shown for this pill's text.
      const text = resolveTooltipText(anchor);
      if (text === null) {
        clearTooltip();
        return;
      }
      tooltipAnchor = anchor;
      // Above the pill: broken-ref.ts's fix popup sits BELOW the same anchor, so
      // placing the info tooltip above keeps the two from overlapping.
      showTooltip(anchor as HTMLElement, text, 'above');
    });
  }

  function onMouseOut(e: MouseEvent): void {
    const anchor = (e.target as HTMLElement).closest('a.md-entity-ref');
    if (anchor && anchor === tooltipAnchor) {
      tooltipAnchor = undefined;
      hideTooltip();
    }
  }

  return { onInput, onMouseMove, onMouseOut };
}
