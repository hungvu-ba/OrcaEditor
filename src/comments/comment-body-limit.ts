/**
 * Req 23 US-23.10 AC10 / US-23.14 AC7: the code-point-safe comment-body length
 * bound shared by every comment-body input (new comment, reply, edit). Pure —
 * no `vscode` import — so both `commentController.ts` (host) and
 * `comment-popover.ts` (webview) import this ONE copy rather than each
 * re-implementing the same cap/counter/clip behavior, mirroring
 * `sidecar-format.ts`'s existing host/webview-shared pattern.
 */

/** Bidi override/isolate control characters — the "Trojan Source" family (LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI). */
function isBidiControlChar(codePoint: number): boolean {
  return (codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069);
}

/** C0/C1 control characters other than `\n` (a comment body is multi-line) and `\t`. */
function isOtherControlChar(codePoint: number): boolean {
  return (codePoint <= 0x1f && codePoint !== 0x0a && codePoint !== 0x09) || (codePoint >= 0x7f && codePoint <= 0x9f);
}

/**
 * Req 23 US-23.10 AC9: strip bidi-override/isolate and other control characters
 * from a comment body before it is inserted into the DOM or written to the
 * sidecar. `textContent` alone does not neutralize these — a bidi override
 * reorders the DISPLAYED text of everything that follows it regardless of how it
 * was inserted.
 *
 * Lives here (host+webview shared, no `vscode`/DOM import) rather than only in
 * `media/webview/dom-utils.ts`, because the NATIVE `vscode.comments` write path
 * never passes through the webview: US-23.14 AC8 lets any user edit any comment,
 * so a body reaching the sidecar unstripped from that surface would let one user
 * reorder the rendered text of another user's comment for every reader.
 * `dom-utils.ts`'s `neutralizeBodyText` delegates here.
 */
export function neutralizeCommentBody(text: string): string {
  let out = '';
  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (isBidiControlChar(codePoint) || isOtherControlChar(codePoint)) {
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Req 23 US-23.10 AC9: a comment body's line endings reconciled to LF before it
 * reaches the sidecar — never `document.eol` (the JSONL sidecar is a separate
 * append-only file, not the `.md`, so this repo's usual reconcile-to-eol rule
 * does not apply). `dom-utils.ts`'s `normalizeBodyEol` delegates here.
 */
export function normalizeCommentBodyEol(text: string): string {
  return text.split('\r\n').join('\n').split('\r').join('\n');
}

/** Hard cap — a comment/reply body cannot exceed this many Unicode code points. */
export const COMMENT_BODY_MAX_CODEPOINTS = 4000;

/** The length counter starts showing once a body reaches this many code points. */
export const COMMENT_BODY_COUNTER_THRESHOLD = 3800;

/** Unicode-code-point-safe length — never splits a surrogate pair. */
export function commentBodyCodePointLength(text: string): number {
  let count = 0;
  for (const _ch of text) {
    count += 1;
  }
  return count;
}

/**
 * Clip a body to `limit` code points, code-point-safe (never splits a surrogate
 * pair) — used when a paste would otherwise push the body over the limit.
 *
 * `limit` is a parameter, not always the cap, so a caller editing a body that is
 * ALREADY longer than the cap can pass that larger length and avoid destroying
 * content it did not author (US-23.14 AC7 / `editRejection`'s same ceiling).
 */
export function clipCommentBodyToLimit(text: string, limit: number = COMMENT_BODY_MAX_CODEPOINTS): string {
  if (commentBodyCodePointLength(text) <= limit) {
    return text;
  }
  let out = '';
  let count = 0;
  for (const ch of text) {
    if (count >= limit) {
      break;
    }
    out += ch;
    count += 1;
  }
  return out;
}
