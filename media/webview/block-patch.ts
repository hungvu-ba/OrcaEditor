/**
 * Performance Audit P-9 — block-level patch plan for host 'update' renders.
 *
 * A host update still renders the FULL markdown (document-global state —
 * reference definitions, footnote numbering, heading-id dedup — makes
 * per-slice renders unsound), but into a detached container. These helpers
 * decide which top-level blocks of the live #content that render actually
 * changed: blocks are compared by their rendered HTML with the
 * data-line/data-line-end VALUES stripped, so an edit above a block (a pure
 * line shift) does not count as a change. main.ts owns the splice itself; the
 * pure pieces live here so they stay unit-testable.
 */
import { hashSource } from './diagram-frame';
import { LINE_NUMBER_ATTR, LINE_NUMBER_END_ATTR, MATH_BLOCK_CLASS } from './render';

/**
 * Stamped on #content by renderDocument after EVERY render, full or patched.
 * Pre-P-9, "a host update happened" was observable as wholesale node
 * detachment (content.innerHTML replaced everything); a patched render keeps
 * untouched nodes alive, so consumers that cached a DOM walk (e.g. the
 * re-attach picker, P-6) must compare this stamp instead of probing a cached
 * node's isConnected.
 */
export const RENDER_GENERATION_ATTR = 'data-render-generation';

/**
 * A block's identity for the patch diff: `${length}:${hash}` of its outerHTML
 * with the line-number attribute VALUES normalized away — a short stamp, so the
 * retained keys do not hold the document's HTML a second time. main.ts keys the
 * RAW (pre-post-process) render, so only inserted blocks get post-processed.
 * The normalization is computed on a clone via the DOM — never by
 * regex over the serialized string: text nodes keep literal `"` when an element
 * is re-serialized, so prose/code that CONTAINS ` data-line="5"` would match a
 * regex and alias two different blocks to one key (review finding, iter 1).
 * The attributes themselves stay (empty-valued), so carrier PRESENCE and
 * position are part of the key: a block whose source span changes while its
 * HTML does not (setext ↔ atx heading, indented ↔ fenced code) gets a new key
 * and is replaced — which also guarantees copySrcLines below only ever pairs
 * blocks with identical carrier structure.
 */
export function lineAgnosticKey(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  for (const carrier of lineCarriers(clone)) {
    if (carrier.hasAttribute(LINE_NUMBER_ATTR)) {
      carrier.setAttribute(LINE_NUMBER_ATTR, '');
    }
    if (carrier.hasAttribute(LINE_NUMBER_END_ATTR)) {
      carrier.setAttribute(LINE_NUMBER_END_ATTR, '');
    }
  }
  const outer = clone.outerHTML;
  return `${outer.length}:${hashSource(outer)}`;
}

export interface BlockPatchPlan {
  /** Leading blocks whose keys match pairwise — keep their live nodes. */
  prefix: number;
  /** Trailing blocks whose keys match pairwise — keep their live nodes. */
  suffix: number;
}

/**
 * Longest common prefix + suffix of the two key lists; everything between is
 * the contiguous run to replace. Clamped so prefix + suffix never exceeds the
 * shorter list — a repeated-block document ("a a" → "a a a") must not claim
 * the same live node for both ends. Deliberately no LCS / move detection: an
 * external edit is one contiguous region, and over-replacing a few blocks is
 * exactly the pre-P-9 behavior, only smaller.
 */
export function planBlockPatch(oldKeys: readonly string[], newKeys: readonly string[]): BlockPatchPlan {
  const max = Math.min(oldKeys.length, newKeys.length);
  let prefix = 0;
  while (prefix < max && oldKeys[prefix] === newKeys[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (suffix < max - prefix && oldKeys[oldKeys.length - 1 - suffix] === newKeys[newKeys.length - 1 - suffix]) {
    suffix++;
  }
  return { prefix, suffix };
}

/** Every element carrying a line attr inside `el`, in document order, `el` itself first. */
function lineCarriers(el: Element): Element[] {
  const list: Element[] = [el];
  for (const d of Array.from(el.querySelectorAll(`[${LINE_NUMBER_ATTR}], [${LINE_NUMBER_END_ATTR}]`))) {
    list.push(d);
  }
  return list;
}

/**
 * Copy the data-line/data-line-end values of `from` (a freshly rendered RAW
 * block) onto `to` (the kept, post-processed live block with the same
 * line-agnostic key). Copying the exact values — rather than shifting by a
 * start-line delta — keeps every carrier correct even when inter-block gaps
 * changed non-uniformly. Because the key includes carrier presence/position
 * (see lineAgnosticKey), equal keys imply identical raw carrier lists. The only
 * carriers post-processing adds are MATH_BLOCK_CLASS wrappers, whose lines come
 * from the math ranges rather than the raw HTML — they are skipped on `to`
 * (main.ts sets them), so the zip aligns 1:1; the length guard is defensive
 * only (copy nothing rather than misalign).
 */
export function copySrcLines(from: Element, to: Element): void {
  const src = lineCarriers(from);
  const dst = lineCarriers(to).filter((el) => !el.classList.contains(MATH_BLOCK_CLASS));
  if (src.length !== dst.length) {
    return;
  }
  for (let i = 0; i < src.length; i++) {
    const line = src[i].getAttribute(LINE_NUMBER_ATTR);
    if (line !== null) {
      dst[i].setAttribute(LINE_NUMBER_ATTR, line);
    }
    const end = src[i].getAttribute(LINE_NUMBER_END_ATTR);
    if (end !== null) {
      dst[i].setAttribute(LINE_NUMBER_END_ATTR, end);
    }
  }
}
