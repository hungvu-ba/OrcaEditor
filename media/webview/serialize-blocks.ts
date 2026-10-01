/**
 * Performance Audit P-7: serialize `#content` one top-level block at a time so a
 * keystroke only re-runs turndown for the block it touched, instead of cloning
 * and re-serializing the whole document at every word boundary.
 *
 * The output must stay BYTE-IDENTICAL to the whole-document pass (`serializeFull`
 * below, which is the previous behaviour moved here verbatim): turndown pads every
 * block-level replacement with its own `\n\n` and caps a boundary at two newlines,
 * so joining per-block results with one blank line reproduces the same string, and
 * `normalizeMarkdown` collapses the ends exactly as before. `test/roundtrip/
 * incremental-serialize.ts` asserts that equality over a corpus instead of trusting
 * the argument.
 *
 * Pure DOM + string work, no live state and no MutationObserver (domino has none):
 * the caller owns the cache and the dirty set, so the round-trip tests drive the
 * PRODUCTION code path rather than a mirror of it.
 */
import { BLOCK_ID_ATTR } from './block-map';
import { detectBlockStyle, stampStyleOverride, LANG_SWITCHED_ATTR } from './block-style';
import { prepareDomForSerialize } from './dom-serialize-prep';
import { normalizeMarkdown } from './turndown';

/** Minimal shape of the turndown service — keeps this module free of its types. */
interface TurndownLike {
  turndown(node: HTMLElement): string;
}

export interface BlockSerializeOptions {
  /** Document used to create the per-block wrapper / comment placeholders. */
  doc: Document;
  turndown: TurndownLike;
  /** Stamp the ORIGINAL style overrides on a whole-document clone (full pass). */
  stampAll?: (cloneRoot: HTMLElement) => void;
  /** Stamp the ORIGINAL style override of the Block Map entry `id` onto `clone`. */
  stampBlock?: (clone: Element, id: string) => void;
  /** Block ids that may not be serialized in isolation (see siblingSensitiveBlockIds). */
  siblingSensitiveIds?: ReadonlySet<string>;
}

/** One cached block: its markdown, and which block ids it was stamped with. */
interface CachedBlock {
  md: string;
  stampKey: string;
  /**
   * Set on a sibling-sensitive block only: the run of top-level nodes `md` was
   * serialized from, the block itself last (see serializeSiblingUnit).
   */
  unit?: readonly Node[];
}

/** Blocks a serialized document is cut into — key is the live node. */
export type BlockMarkdownCache = WeakMap<Node, CachedBlock>;

/**
 * `cloneNode` does not copy the `checked` PROPERTY, so mirror it onto the clone's
 * attribute (a checkbox toggled by click carries the new state on the property).
 */
function syncCheckboxes(live: Element, clone: Element): void {
  const liveInputs = live.querySelectorAll('input[type="checkbox"]');
  const cloneInputs = clone.querySelectorAll('input[type="checkbox"]');
  liveInputs.forEach((input, i) => {
    const c = cloneInputs[i];
    if (!c) {
      return;
    }
    c.toggleAttribute('checked', (input as HTMLInputElement).checked);
  });
}

/**
 * Markdown of a run of consecutive top-level children of `#content` — ONE child on
 * the common path — serialized on its own. Wrapped in a throwaway div because
 * turndown serializes a root's CHILDREN; the wrapper itself emits nothing.
 */
function serializeTopLevelNodes(
  nodes: readonly Node[],
  opts: BlockSerializeOptions,
  stampIds: readonly string[]
): string {
  const wrapper = opts.doc.createElement('div');
  for (const node of nodes) {
    const clone = node.cloneNode(true);
    wrapper.appendChild(clone);
    if (node.nodeType === 1 /* ELEMENT_NODE */) {
      syncCheckboxes(node as Element, clone as Element);
    }
  }
  prepareDomForSerialize(wrapper, opts.doc);
  // Look the targets up in the WRAPPER, after prepare — exactly like the
  // whole-document pass. Two reasons the captured `clone` is not good enough:
  // prepareDomForSerialize can replace the node it was given (an HTML comment
  // becomes a placeholder span), and the id can sit on a DESCENDANT rather than the
  // block itself (wrapInBlockquote rebuilds the block from its outerHTML, carrying
  // data-block-id down into the nested <p>).
  for (const id of stampIds) {
    const target = wrapper.querySelector(`[${BLOCK_ID_ATTR}="${id}"]`);
    if (target) {
      opts.stampBlock?.(target, id);
    }
  }
  // turndown already trims both ends of its output; the blank line between blocks
  // is added by serializeChildren.
  return opts.turndown.turndown(wrapper);
}

/**
 * Tags that turndown treats as block level AND that legitimately appear as a direct
 * child of `#content` — markdown-it's block tokens, the raw-HTML blocks a user can
 * write, and the frames the postprocess passes build (all `div`).
 */
const TOP_LEVEL_BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CENTER', 'DD', 'DETAILS', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR',
  'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'UL',
]);

/**
 * True when every direct child of `root` can be serialized on its own.
 *
 * turndown pads a BLOCK replacement with its own `\n\n` and joins two replacements
 * with the larger of the two sides' padding — so a block next to anything always
 * ends up with the one blank line the per-block join inserts. Two ADJACENT
 * NON-BLOCK children do not: turndown joins them with NOTHING (or a collapsed
 * space, or the single newline a `<br>` carries), and the per-block join would
 * split one line into separate paragraphs. `Hello <em>world</em>!` as three top-level
 * children — a state contentEditable reaches after select-all-and-type, Shift+Enter
 * at document level or some pastes — must not become three paragraphs in the user's
 * file, so such a document takes the whole-document pass instead.
 *
 * A LONE non-block child between blocks is fine, and that case matters: this
 * project stores sized/dropped images as raw `<img>` lines and markdown-it leaves
 * them (and standalone HTML comments) as top-level non-block children. Killing the
 * optimisation for every file containing one would cost more than it buys.
 *
 * Whitespace-only text is transparent next to a block (turndown's collapseWhitespace
 * drops it) but NOT between two non-block children, where it collapses to a real
 * space — so it does not break up a run.
 */
function canSerializePerBlock(root: HTMLElement): boolean {
  let previousWasNonBlock = false;
  for (let node = root.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 3 /* TEXT_NODE */ && !(node.nodeValue ?? '').trim()) {
      continue;
    }
    const isBlock = node.nodeType === 1 /* ELEMENT_NODE */ && TOP_LEVEL_BLOCK_TAGS.has(node.nodeName);
    if (!isBlock && previousWasNonBlock) {
      return false;
    }
    previousWasNonBlock = !isBlock;
  }
  return true;
}

/**
 * Which block ids each top-level child must stamp, mirroring the whole-document
 * pass exactly: one index over the live tree, FIRST element in document order wins
 * per id, and the winner is attributed to the top-level child that contains it.
 *
 * Both halves are load-bearing. Ids duplicate — Blink clones the block element,
 * attributes included, when Enter splits it, and nothing de-duplicates
 * `data-block-id` until the next render — and ids move down a level whenever an op
 * rebuilds a block from its `outerHTML` (Quote → `wrapInBlockquote`), leaving the
 * new top-level element with no id of its own.
 */
function stampPlan(root: HTMLElement): Map<Node, string[]> {
  const winners = new Map<string, Element>();
  for (const el of root.querySelectorAll(`[${BLOCK_ID_ATTR}]`)) {
    const id = el.getAttribute(BLOCK_ID_ATTR);
    if (id && !winners.has(id)) {
      winners.set(id, el);
    }
  }
  const plan = new Map<Node, string[]>();
  for (const [id, el] of winners) {
    let owner: Node | null = el;
    while (owner && owner.parentNode !== root) {
      owner = owner.parentNode;
    }
    if (!owner) {
      continue;
    }
    const ids = plan.get(owner);
    if (ids) {
      ids.push(id);
    } else {
      plan.set(owner, [id]);
    }
  }
  return plan;
}

const NO_IDS: readonly string[] = [];

/** Markdown of the top-level nodes `first`..`last` — one node, or a sibling-sensitive unit. */
interface SerializedPart {
  first: Node;
  last: Node;
  md: string;
}

/**
 * A sibling-sensitive block (`opts.siblingSensitiveIds`) is serialized in ONE
 * wrapper with the nodes it depends on — a "unit" — and the unit's markdown
 * replaces the parts those nodes already contributed to `parts`:
 *  - back to and including its live `previousElementSibling`, the node turndown's
 *    code rule reads (a list there turns indented code into a fence);
 *  - further back while the unit would START with empty markdown, down to
 *    `root.firstChild`: turndown strips a leading `\t` from every result, so
 *    tab-indented code may only lead the wrapper where it leads the whole document.
 * Folding back into an earlier unit takes that whole unit, so units never overlap.
 *
 * The folded nodes were serialized on their own first — that is what tells an
 * empty one apart, and it keeps their own cache entry current for the day the unit
 * splits. The unit is cached on the sensitive block: a hit needs the same nodes,
 * none of them dirty, stamped with the same ids.
 */
function serializeSiblingUnit(
  block: Node,
  parts: SerializedPart[],
  plan: Map<Node, string[]>,
  opts: BlockSerializeOptions,
  cache: BlockMarkdownCache,
  dirty: Set<Node>
): SerializedPart {
  const previous = (block as Element).previousElementSibling;
  let first = block;
  let holdsPrevious = false;
  let lead = '';
  while (parts.length && !(holdsPrevious && lead)) {
    const part = parts.pop() as SerializedPart;
    first = part.first;
    lead = part.md;
    holdsPrevious = holdsPrevious || part.last === previous;
  }
  const unit: Node[] = [];
  const stampIds: string[] = [];
  for (let node: Node | null = first; node; node = node === block ? null : node.nextSibling) {
    unit.push(node);
    stampIds.push(...(plan.get(node) ?? NO_IDS));
  }
  const stampKey = stampIds.join(' ');
  const cached = cache.get(block);
  const cachedUnit = cached?.unit;
  if (
    cached?.stampKey === stampKey &&
    cachedUnit?.length === unit.length &&
    unit.every((node, i) => node === cachedUnit[i] && !dirty.has(node))
  ) {
    return { first, last: block, md: cached.md };
  }
  // turndown trims the END of every result too, but blanks ending the last code line
  // survive wherever a block follows: serialize a throwaway paragraph after the unit
  // and cut it back off (serializeChildren trims the end of the document).
  const end = opts.doc.createElement('p');
  end.textContent = 'x';
  const md = serializeTopLevelNodes([...unit, end], opts, stampIds).slice(0, -1).replace(/\n+$/, '');
  cache.set(block, { md, stampKey, unit });
  return { first, last: block, md };
}

/**
 * Whole-document markdown built from the per-block results: cached blocks are
 * reused verbatim, everything else (dirty, or never seen — a block just created by
 * an edit or a re-render) is re-serialized. `dirty` is consumed and cleared.
 */
export function serializeChildren(
  root: HTMLElement,
  opts: BlockSerializeOptions,
  cache: BlockMarkdownCache,
  dirty: Set<Node>
): string {
  if (!canSerializePerBlock(root)) {
    // `dirty` is deliberately NOT cleared: the whole-document pass fills no cache,
    // so a block edited during a fallback must still count as dirty once the
    // document goes back to the per-block path — otherwise its stale cached
    // markdown is served and the edit is silently reverted in the user's file.
    return serializeFull(root, opts);
  }
  const parts: SerializedPart[] = [];
  const plan = stampPlan(root);
  const sensitiveIds = opts.siblingSensitiveIds;
  for (let node = root.firstChild; node; node = node.nextSibling) {
    const stampIds = plan.get(node) ?? NO_IDS;
    if (sensitiveIds?.size && stampIds.some((id) => sensitiveIds.has(id))) {
      parts.push(serializeSiblingUnit(node, parts, plan, opts, cache, dirty));
      continue;
    }
    // The stamp targets are part of the cache key: a block whose twin was deleted
    // (or whose id moved) now stamps differently and must be re-serialized.
    const stampKey = stampIds.join(' ');
    const cached = dirty.has(node) ? undefined : cache.get(node);
    let md = cached?.stampKey === stampKey ? cached.md : undefined;
    if (md === undefined) {
      md = serializeTopLevelNodes([node], opts, stampIds);
      cache.set(node, { md, stampKey });
    }
    parts.push({ first: node, last: node, md });
  }
  dirty.clear();
  const blocks = parts.map((part) => part.md).filter((md) => md);
  // trimEnd: a sibling-sensitive unit keeps the blanks ending its last line, which
  // the whole-document pass drops only where that line ends the document.
  return normalizeMarkdown(blocks.join('\n\n').trimEnd());
}

/** The previous whole-document pass — kept as the reference path and the fallback. */
export function serializeFull(root: HTMLElement, opts: BlockSerializeOptions): string {
  const clone = root.cloneNode(true) as HTMLElement;
  syncCheckboxes(root, clone);
  prepareDomForSerialize(clone, opts.doc);
  opts.stampAll?.(clone);
  return normalizeMarkdown(opts.turndown.turndown(clone));
}

/** What stamping a block's original style needs from its Block Map entry. */
interface BlockStyleSource {
  id: string;
  type: string;
  mdSlice: string;
}

/**
 * US-18.4a: stamp ONE block's ORIGINAL style override onto its serialize-time
 * clone, so turndown reproduces the `.md` syntax variant the user wrote instead of
 * the global style. A block with no `mdSlice` (new content) gets nothing.
 */
export function stampBlockStyle(clone: Element, entry: BlockStyleSource): void {
  if (!entry.mdSlice) {
    return;
  }
  const style = detectBlockStyle(entry.mdSlice, entry.type);
  // US-4.28: a block whose language the user switched in place must not be
  // re-forced back to its ORIGINAL indented syntax — indented code can't carry a
  // language, so turndown would drop the pick. Drop the code axis so it serializes
  // as a fence (only indented needs this; tilde fences keep a lang).
  if (clone.hasAttribute(LANG_SWITCHED_ATTR) && (style.code === 'indented' || style.code === 'indented-tab')) {
    style.code = null;
  }
  stampStyleOverride(clone, style);
}

/**
 * Whole-document variant: index the clone's blocks ONCE (Performance Audit P-2 —
 * a querySelector per entry was O(blocks × tree)) and stamp each Block Map entry.
 */
export function stampBlockStyles(cloneRoot: Element, entries: Iterable<BlockStyleSource>): void {
  const byId = new Map<string, Element>();
  for (const el of cloneRoot.querySelectorAll(`[${BLOCK_ID_ATTR}]`)) {
    const id = el.getAttribute(BLOCK_ID_ATTR);
    // First match wins, matching querySelector's document-order semantics.
    if (id && !byId.has(id)) {
      byId.set(id, el);
    }
  }
  for (const entry of entries) {
    const el = byId.get(entry.id);
    if (el) {
      stampBlockStyle(el, entry);
    }
  }
}

/**
 * Ids of the blocks whose markdown depends on a SIBLING block, so they may not be
 * serialized in isolation (`serializeChildren` serializes each with its neighbours).
 *
 * Only one such block exists: an indented code block falls back to a fence when it
 * directly follows a list (`turndown.ts`'s mdCodeBlock rule reads
 * `previousElementSibling`). Caching makes it doubly unsafe — deleting the list in
 * front of an untouched `pre` would silently keep its stale indented form — so the
 * cached markdown is tied to the neighbours it was serialized with. Read from the
 * Block Map because the style lives in `mdSlice`; it is stamped on the
 * serialize-time clone, never on the live DOM.
 *
 * Do NOT narrow this to "indented code that follows a list": the `indented-tab`
 * variant needs the same guard for an unrelated reason — turndown's postProcess
 * strips leading `\t` from EVERY result, so serialized on its own the block loses
 * the indent that made it code at all (`\tcode` → `code`), and it stops being a
 * code block when the file is re-parsed.
 */
export function siblingSensitiveBlockIds(entries: Iterable<{ id: string; type: string; mdSlice: string }>): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== 'code' || !entry.mdSlice) {
      continue;
    }
    const { code } = detectBlockStyle(entry.mdSlice, entry.type);
    if (code === 'indented' || code === 'indented-tab') {
      ids.add(entry.id);
    }
  }
  return ids;
}
