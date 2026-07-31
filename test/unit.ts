/**
 * Unit test cho logic THUẦN của extension host (src/text-utils.ts) — không cần
 * VS Code runtime. Bao computeMinimalEdit, normalizeForSearch, relativePath,
 * classifyLink (scheme allowlist) và một kiểm tra type-level của message
 * contract (src/shared/messages.ts). (finding C6)
 *
 * Cũng gồm security tripwire đọc src/provider.ts dạng text (xem cuối file) —
 * provider.ts import 'vscode' nên không import trực tiếp được ở đây.
 *
 * Chạy: npm run test:unit
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathSegmentsContainSymlink } from '../src/fs-guard';
import {
  classifyLink,
  computeMinimalEdit,
  driveMismatchHint,
  entityFollowingLabel,
  entityFollowingPreview,
  imageNamePrefix,
  isPathTooLongError,
  normalizeAssetName,
  normalizeCustomFolderPath,
  normalizeEol,
  normalizeForSearch,
  orphanAssetNames,
  rebuildFromEditDiff,
  referencedAssetBasenames,
  relativePath,
  sameDocumentUri,
  sanitizeDroppedFileName,
  type MinimalEdit,
} from '../src/text-utils';
import { isWindowsDrivePath, isWindowsUncPath, hasUrlScheme } from '../src/shared/link-scheme';
import type { HostToWebview, TriggerConfig, WebviewToHost } from '../src/shared/messages';
import { EntityIndex, parseEntities, nearestEnclosingHeading, type IndexedEntity } from '../src/entity-index';
import { canonicalEntityId, scanEntityOccurrences } from '../src/occurrence-scan';
import { findTextMatches, type MatchOptions } from '../src/shared/text-match';
import { detectBlockStyle, type StyleOverride } from '../media/webview/block-style';
import { MarkdownRenderer } from '../media/webview/render';
import { tomlErrorLine } from '../media/webview/front-matter';
import { copySrcLines, lineAgnosticKey, planBlockPatch } from '../media/webview/block-patch';
import domino from '@mixmark-io/domino';
import { truncateDisplay } from '../media/webview/trigger-popup';
import { headingSiblingGaps } from '../media/webview/drag-drop';
import { buildGroups } from '../media/webview/comment-gutter';
import { orphanKindLabel } from '../media/webview/comment-panel';
import type { ThreadAnchor } from '../media/webview/comment-resolve';
import {
  anchorUpdateRejection,
  authorNamePromptRejection,
  commentThreadLine,
  copyConfirmationMessage,
  createCommentRejection,
  deleteRejection,
  editRejection,
  nextAuthoritativePanel,
  replyRejection,
  resolveCommentAuthor,
  commentThreadContextValue,
  statusChangeRejection,
  STATUS_CHANGE_TARGET,
  type AnchorUpdateMessage,
  type CreateCommentMessage,
  type DeleteCommentMessage,
  type EditCommentMessage,
  type ReplyMessage,
  type StatusChangeMessage,
} from '../src/comments/comment-utils';
import {
  buildSnippetLine,
  copyDisabledReason,
  escapeMarkdownInline,
  formatExportTimestamp,
  renderCommentsMarkdown,
  type ExportSnapshot,
  type ExportThread,
} from '../media/webview/comment-copy-markdown';
import {
  buildAnchorUpdateLine,
  buildCommentLine,
  buildDeleteLine,
  buildEditLine,
  buildReplyLine,
  buildStatusChangeLine,
  foldSidecarRecords,
  isSidecarName,
  mdNameForSidecar,
  pruneDeadSidecarLines,
  removeSidecarLineCascade,
  sidecarBelongsToDocument,
  parseSidecarText,
  serializeSidecarLine,
  sameAuthor,
  sidecarBackupNameFor,
  sidecarNameFor,
  sidecarNameMatches,
  type AnchorUpdateLine,
  type CommentLine,
  type CommentStatus,
  type DeleteLine,
  type EditLine,
  type SidecarThread,
  type ReplyLine,
  type StatusChangeLine,
} from '../src/comments/sidecar-format';
import { sidecarShareWarning } from '../src/comments/sidecar-git';
import {
  canForwardUndo,
  emptyUndoLedger,
  recordUndoLedgerChange,
  undoLedgerReasonOf,
  type UndoLedger,
  type UndoLedgerReason,
} from '../src/undo-ledger';
import {
  clipCommentBodyToLimit,
  commentBodyCodePointLength,
  neutralizeCommentBody,
  normalizeCommentBodyEol,
  COMMENT_BODY_COUNTER_THRESHOLD,
  COMMENT_BODY_MAX_CODEPOINTS,
} from '../src/comments/comment-body-limit';
import {
  anchorTextRetention,
  anchorThresholdFor,
  driftBandFor,
  levenshtein,
  normalizeAnchorText,
  pickAnchorCandidate,
  rankReattachTargets,
  similarity,
  type AnchorCandidate,
} from '../media/webview/comment-anchor';
import { countWords, estimateReadMinutes, formatCount } from '../media/webview/reading-stats';
import { neutralizeBodyText, normalizeBodyEol } from '../media/webview/dom-utils';
import {
  collectClassConstants,
  exportedConstants,
  findAmbiguousConstants,
  readTransientClassIdentifiers,
  scanStampedClasses,
  OUTSIDE_CONTENT_CLASSES,
  UNRESOLVED_STAMP_EXEMPTIONS,
  type SourceFile,
  type StampSite,
} from './transient-class-scan';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}`);
    failures.push(`--- ${name} ---${detail ? '\n' + detail : ''}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `  nhận:    ${a}\n  kỳ vọng: ${e}`);
}

// ---------------------------------------------------------------------------
// computeMinimalEdit — bất biến then chốt: áp diff lại phải tái tạo newText.
// ---------------------------------------------------------------------------

/** Mô phỏng cách provider áp WorkspaceEdit: thay [start, oldEnd) bằng newText. */
function applyEdit(oldText: string, diff: MinimalEdit): string {
  return oldText.slice(0, diff.start) + diff.newText + oldText.slice(diff.oldEnd);
}

interface EditCase {
  name: string;
  oldText: string;
  newText: string;
  expect: MinimalEdit | null;
}

const editCases: EditCase[] = [
  { name: 'edit: hai chuỗi rỗng → no-op', oldText: '', newText: '', expect: null },
  { name: 'edit: oldText === newText → no-op', oldText: 'abc', newText: 'abc', expect: null },
  { name: 'edit: chèn vào chuỗi rỗng', oldText: '', newText: 'hello', expect: { start: 0, oldEnd: 0, newText: 'hello' } },
  { name: 'edit: xóa toàn bộ về rỗng', oldText: 'hello', newText: '', expect: { start: 0, oldEnd: 5, newText: '' } },
  { name: 'edit: thêm ở giữa', oldText: 'abcf', newText: 'abcdef', expect: { start: 3, oldEnd: 3, newText: 'de' } },
  { name: 'edit: xóa ở giữa', oldText: 'abcdef', newText: 'abcf', expect: { start: 3, oldEnd: 5, newText: '' } },
  { name: 'edit: thay ở giữa', oldText: 'abXYef', newText: 'abZef', expect: { start: 2, oldEnd: 4, newText: 'Z' } },
  { name: 'edit: prefix chồng lấn với suffix (aaa→aa)', oldText: 'aaa', newText: 'aa', expect: { start: 2, oldEnd: 3, newText: '' } },
  { name: 'edit: prefix/suffix trùng ký tự (xx→xxx)', oldText: 'xx', newText: 'xxx', expect: { start: 2, oldEnd: 2, newText: 'x' } },
  {
    // 'e' + combining grave (2 code unit) → 'e' + combining acute: chỉ dấu đổi.
    name: 'edit: tiếng Việt tổ hợp (combining) thay dấu',
    oldText: 'e\u0300', // e + combining grave
    newText: 'e\u0301', // e + combining acute
    expect: { start: 1, oldEnd: 2, newText: '\u0301' },
  },
  {
    name: 'edit: surrogate pair (emoji) chèn giữa',
    oldText: 'a\u{1F600}b', // a😀b (😀 = 2 code unit)
    newText: 'a\u{1F600}\u{1F389}b', // a😀🎉b
    expect: { start: 3, oldEnd: 3, newText: '\u{1F389}' },
  },
];

for (const c of editCases) {
  const diff = computeMinimalEdit(c.oldText, c.newText);
  eq(c.name, diff, c.expect);
  // Bất biến: áp diff (nếu có) phải tái tạo đúng newText.
  const rebuilt = diff ? applyEdit(c.oldText, diff) : c.oldText;
  check(`${c.name} [tái tạo newText]`, rebuilt === c.newText, `  nhận: ${JSON.stringify(rebuilt)}`);
}

// Kiểm tra ngẫu nhiên: với mọi cặp chuỗi, áp diff phải tái tạo newText.
{
  const alphabet = 'ab😀ữ\n ';
  const rnd = (n: number) => Math.floor(Math.random() * n);
  const randStr = () => {
    let s = '';
    const len = rnd(8);
    for (let i = 0; i < len; i++) {
      s += alphabet[rnd(alphabet.length)];
    }
    return s;
  };
  let ok = true;
  for (let i = 0; i < 500; i++) {
    const a = randStr();
    const b = randStr();
    const d = computeMinimalEdit(a, b);
    const rebuilt = d ? applyEdit(a, d) : a;
    if (rebuilt !== b) {
      ok = false;
      failures.push(`--- fuzz edit ---\n  a=${JSON.stringify(a)} b=${JSON.stringify(b)} d=${JSON.stringify(d)}`);
      break;
    }
  }
  check('edit: fuzz 500 cặp — áp diff luôn tái tạo newText', ok);
}

// ---------------------------------------------------------------------------
// normalizeEol + reconcile before diffing (X-2: a CRLF document is not rewritten).
// ---------------------------------------------------------------------------

// Pure behavior of normalizeEol.
eq('eol: LF pass-through when !useCrlf', normalizeEol('# A\n\nB\n', false), '# A\n\nB\n');
eq('eol: LF -> CRLF when useCrlf', normalizeEol('# A\n\nB\n', true), '# A\r\n\r\nB\r\n');
eq('eol: idempotent — existing CRLF not doubled to \\r\\r\\n', normalizeEol('# A\r\n\r\nB\r\n', true), '# A\r\n\r\nB\r\n');
eq('eol: mixed \\r\\n + \\n -> all CRLF', normalizeEol('a\r\nb\nc', true), 'a\r\nb\r\nc');

// Core X-2: same CRLF-doc vs LF-newText pair.
// - WITHOUT reconcile → the diff mismatches at the first \r → span ~= whole document (bug).
// - WITH reconcile → minimal span around "B"->"B!", and reapplying stays all-CRLF.
{
  const crlfDoc = '# A\r\n\r\nB\r\n';
  const lfNewText = '# A\n\nB!\n'; // webview serialize() is always LF, only appends '!' after B.

  // Control (no normalize): reproduces the bug — the edit spans almost the whole document.
  const buggy = computeMinimalEdit(crlfDoc, lfNewText);
  const buggySpan = buggy ? buggy.oldEnd - buggy.start : 0;
  check(
    'eol[X-2]: NO reconcile → span = whole-doc (bug)',
    buggySpan > crlfDoc.length / 2,
    `  span=${buggySpan} / docLen=${crlfDoc.length}`
  );

  // Fix: reconcile the LF newText to CRLF before diffing.
  const reconciled = normalizeEol(lfNewText, true);
  const fixed = computeMinimalEdit(crlfDoc, reconciled);
  const fixedSpan = fixed ? fixed.oldEnd - fixed.start : 0;
  check(
    'eol[X-2]: reconcile → minimal span (no whole-file rewrite)',
    fixed !== null && fixedSpan <= 2,
    `  span=${fixedSpan} diff=${JSON.stringify(fixed)}`
  );

  // Reapplying the reconciled edit → result is still all-CRLF, no bare LF mixed in.
  const rebuilt = fixed ? applyEdit(crlfDoc, fixed) : crlfDoc;
  eq('eol[X-2]: reapply keeps CRLF', rebuilt, '# A\r\n\r\nB!\r\n');
  check('eol[X-2]: result has no bare LF', !/(^|[^\r])\n/.test(rebuilt), `  got: ${JSON.stringify(rebuilt)}`);
}

// X-2 (caret half): the echo-suppression key must match the document's EOL.
// provider.ts import 'vscode' → can't load here; MODEL the echo decision of
// case 'edit' + changeSubscription. The webview always posts LF; applyMinimalEdit
// writes the reconciled (CRLF-on-a-CRLF-doc) text. If `lastTextFromWebview` keeps
// the raw LF, getText() (CRLF) never equals it → a full 'update' re-renders
// #content on EVERY keystroke → lost caret. Reconciling the key suppresses it.
{
  function makeCrlfHost(reconcileEchoKey: boolean) {
    const useCrlf = true;
    let doc = '# A\r\n\r\nB\r\n'; // CRLF document (tool-generated / Windows file)
    let lastTextFromWebview: string | undefined;
    let updatesPosted = 0; // each one = a full renderDocument() → caret loss

    // changeSubscription: echo-check only (provider.ts:522).
    function onChange(newDocText: string): void {
      doc = newDocText;
      if (newDocText === lastTextFromWebview) {
        return; // echo of our own edit → no re-render
      }
      lastTextFromWebview = undefined;
      updatesPosted++;
    }

    // case 'edit' (provider.ts:642 + applyMinimalEdit). `text` is the LF serialize.
    function edit(lfText: string): void {
      lastTextFromWebview = reconcileEchoKey ? normalizeEol(lfText, useCrlf) : lfText;
      const reconciled = normalizeEol(lfText, useCrlf); // applyMinimalEdit always writes this
      const diff = computeMinimalEdit(doc, reconciled);
      onChange(diff ? applyEdit(doc, diff) : doc);
    }
    return {
      edit,
      external: onChange, // git/format/external editor: a change with no matching echo key
      get updates() { return updatesPosted; },
      get docText() { return doc; },
    };
  }

  // Reproduce-first: raw LF key → every keystroke on a CRLF doc posts an update.
  const buggy = makeCrlfHost(false);
  buggy.edit('# A\n\nB!\n'); // type "!" after B
  buggy.edit('# A\n\nB!?\n'); // type "?" — a second keystroke
  check('eol[X-2 caret]: raw LF echo-key → update on every keystroke (bug)', buggy.updates === 2, `  updates=${buggy.updates}`);

  // Fix: reconcile the echo key → no update echoed back → no re-render → caret kept.
  const fixed = makeCrlfHost(true);
  fixed.edit('# A\n\nB!\n');
  fixed.edit('# A\n\nB!?\n');
  check('eol[X-2 caret]: reconciled echo-key → zero echo updates (fix)', fixed.updates === 0, `  updates=${fixed.updates}`);
  eq('eol[X-2 caret]: document stays CRLF through the edits', fixed.docText, '# A\r\n\r\nB!?\r\n');

  // Regression guard: a genuine external edit (git/format) must still post an update.
  const ext = makeCrlfHost(true);
  ext.external('# A\r\n\r\nC\r\n');
  check('eol[X-2 caret]: real external edit still posts update (no over-suppress)', ext.updates === 1);
}

// ---------------------------------------------------------------------------
// P-8 (Plan/Performance — Audit.md): webview→host 'edit' ships only the CHANGED
// REGION. provider.ts imports 'vscode' so it can't load here — MODEL both ends
// of the protocol (webview `appliedRev` + syncNow; host mirror + case 'edit')
// around the REAL rebuildFromEditDiff/computeMinimalEdit/normalizeEol, and hold
// it to one bar: the document must land byte-identical to what the pre-P-8
// full-text send produced, in every divergence case too.
// ---------------------------------------------------------------------------

/** Both ends of the P-8 protocol, wired to each other. `useCrlf` = a Windows/tool-generated document. */
function makeP8Pair(initialDoc: string, useCrlf = false) {
  // ---- host (src/provider.ts) ----
  // Seeded as the 'init' push leaves things: pushDocumentText stamped rev 1 onto
  // the initial text and the webview rendered it, so both sides open on rev 1
  // and seq 0 (the webview has authored nothing yet).
  let doc = initialDoc;
  let mirrorText = initialDoc;
  let mirrorRev = 1;
  let mirrorSeq = 0;
  let lastPushCaret: number | undefined;
  let pushRev = 1;
  let resyncsRequested = 0;
  let fullPushesRequested = 0;
  let diffPayload = 0; // wire chars spent on diff-shaped edits
  let fullPayload = 0; // wire chars spent on full-text edits
  let pushDiffPayload = 0; // wire chars spent on diff-shaped host pushes (the reverse half)
  let pushFullPayload = 0; // wire chars spent on full-text host pushes

  /** case 'edit' — resolves BOTH wire shapes to one full text, then applies it as before. */
  function hostOnEdit(msg: WebviewToHost & { type: 'edit' }): void {
    let text: string;
    if ('text' in msg) {
      fullPayload += msg.text.length;
      text = msg.text;
      mirrorText = text;
      mirrorRev = msg.baseRev; // re-anchor onto the rev the webview is really on
      mirrorSeq = msg.seq;
    } else {
      diffPayload += msg.newText.length;
      const rebuilt = msg.baseRev === mirrorRev ? rebuildFromEditDiff(mirrorText, msg) : null;
      if (rebuilt === null) {
        resyncsRequested++;
        wv.onRequestFullSync(); // host → webview 'requestFullSync', answered synchronously here
        return;
      }
      text = rebuilt;
      mirrorText = text;
      mirrorSeq = msg.seq; // only on acceptance — a refused diff leaves the mirror behind
    }
    // applyMinimalEdit — unchanged by P-8: always a full text in, minimal edit out.
    const reconciled = normalizeEol(text, useCrlf);
    const d = computeMinimalEdit(doc, reconciled);
    doc = d ? applyEdit(doc, d) : doc;
  }

  function pushDocumentText(text: string): number {
    pushRev++;
    mirrorText = text;
    mirrorRev = pushRev;
    return pushRev;
  }

  /**
   * updateMessage — the reverse half: diff `mirrorText → pushed`, or full text
   * when there is nothing to diff. Captures the base BEFORE pushDocumentText
   * re-anchors the mirror onto this very push.
   */
  function updateMessage(pushed: string, caret?: number): HostToWebview & { type: 'update' } {
    const diff = computeMinimalEdit(mirrorText, pushed);
    const baseRev = mirrorRev;
    const baseLength = mirrorText.length;
    const baseSeq = mirrorSeq;
    // Only a diff can be refused, and only undo/redo carries a caret — remember it
    // so the healing full push can replay it instead of dropping it.
    lastPushCaret = caret;
    if (!diff || mirrorSeq < 0) {
      // mirrorSeq < 0: a webview-authored advance reached us without its seq, so a
      // diff is GUARANTEED to be refused — go straight to full text.
      pushFullPayload += pushed.length;
      return { type: 'update', text: pushed, caretLine: caret, rev: pushDocumentText(pushed) };
    }
    pushDiffPayload += diff.newText.length;
    return {
      type: 'update',
      start: diff.start,
      oldEnd: diff.oldEnd,
      newText: diff.newText,
      baseLength,
      baseRev,
      baseSeq,
      caretLine: caret,
      rev: pushDocumentText(pushed),
    };
  }

  /**
   * Every host push goes through here (pushDocumentText, via updateMessage). A
   * push always originates from a document that ALREADY holds `text` (an external
   * change, or the post-undo state), so the document moves with it — that is what
   * `case 'requestFullPush'` re-reads when a diff is refused.
   */
  function hostPush(text: string, defer = false, caret?: number): void {
    // document.getText() is the document's OWN eol, and that is what both the push
    // and the mirror carry — the webview's currentText holds it verbatim.
    const pushed = normalizeEol(text, useCrlf);
    doc = pushed;
    wv.onUpdate(updateMessage(pushed, caret), defer);
  }

  /** case 'requestFullPush' — re-push the CURRENT document in full; needs no base, so it always lands. */
  function hostOnRequestFullPush(): void {
    fullPushesRequested++;
    pushFullPayload += doc.length;
    // Replays the refused push's caret: dropping it is what made a refused undo
    // land the caret at the pre-render snapshot instead of at the undone edit.
    wv.onUpdate({ type: 'update', text: doc, caretLine: lastPushCaret, rev: pushDocumentText(doc) }, false);
  }

  // ---- webview (media/webview/main.ts) ----
  const wv = {
    currentText: initialDoc,
    appliedRev: 1,
    localSeq: 0,
    lastCaret: undefined as number | undefined,
    pending: undefined as { text: string; rev: number; baseText: string } | undefined,
    /**
     * syncNow(): serialize, diff against the PRE-edit text, post the changed
     * region. `hold` models an 'edit' the webview has POSTED but the host has not
     * received yet — `currentText`/`localSeq` have already advanced. Returns the
     * held message so a test can deliver it later.
     */
    type(newFullText: string, hold = false): (WebviewToHost & { type: 'edit' }) | undefined {
      const prevText = wv.currentText;
      if (newFullText === prevText) {
        return undefined;
      }
      wv.currentText = newFullText;
      wv.localSeq++; // serializeIfChanged: the one webview-authored advance
      const d = computeMinimalEdit(prevText, newFullText)!;
      const msg: WebviewToHost & { type: 'edit' } = {
        type: 'edit',
        start: d.start,
        oldEnd: d.oldEnd,
        newText: d.newText,
        baseLength: prevText.length,
        baseRev: wv.appliedRev,
        seq: wv.localSeq,
      };
      if (hold) {
        return msg;
      }
      hostOnEdit(msg);
      return undefined;
    },
    /** resolveUpdateText — either wire shape to one full text; undefined = refuse. */
    resolveUpdateText(msg: HostToWebview & { type: 'update' }): string | undefined {
      if ('text' in msg) {
        return msg.text;
      }
      if (msg.baseRev !== wv.appliedRev || msg.baseSeq !== wv.localSeq) {
        return undefined;
      }
      return rebuildFromEditDiff(wv.currentText, msg) ?? undefined;
    },
    onUpdate(msg: HostToWebview & { type: 'update' }, defer: boolean): void {
      const next = wv.resolveUpdateText(msg);
      if (next === undefined) {
        hostOnRequestFullPush(); // nothing applied — ask for a base-free push
        return;
      }
      // applyDocumentUpdate's caret argument — undefined means "no caret came with
      // this update", which is the fallback-to-snapshot branch, not a position.
      wv.lastCaret = msg.caretLine;
      if (next === wv.currentText) {
        wv.appliedRev = msg.rev; // same text — adopting keeps both sides on one rev
        // A queued deferred update older than this rev is stale: rendering it on
        // release would put back content the document moved past AND drag
        // appliedRev backwards. The flush guard only compares baseText.
        if (wv.pending && wv.pending.rev <= wv.appliedRev) {
          wv.pending = undefined;
        }
        return;
      }
      if (defer) {
        // A trigger popup owns the keyboard: stash WITHOUT adopting the rev.
        wv.pending = { text: next, rev: msg.rev, baseText: wv.currentText };
        return;
      }
      wv.currentText = next;
      wv.appliedRev = msg.rev;
    },
    flushPending(): void {
      const u = wv.pending;
      wv.pending = undefined;
      if (!u || wv.currentText !== u.baseText || u.text === wv.currentText) {
        return; // stale — the local DOM wins, and the rev is NOT adopted
      }
      wv.currentText = u.text;
      wv.appliedRev = u.rev;
    },
    onRequestFullSync(): void {
      hostOnEdit({ type: 'edit', text: wv.currentText, baseRev: wv.appliedRev, seq: wv.localSeq });
    },
  };

  return {
    wv,
    hostPush,
    /** Deliver an 'edit' the webview held back (see wv.type's `hold`). */
    deliver(msg: WebviewToHost & { type: 'edit' }): void { hostOnEdit(msg); },
    /**
     * case 'undo'/'redo' receiving `pendingText` — the one webview-authored
     * advance that reaches the host WITHOUT an 'edit'. Mirrors text and seq
     * synchronously at receipt; `seq === undefined` models the field missing from
     * the wire, which must leave the mirror unable to claim agreement.
     */
    mirrorPending(pendingText: string, seq: number | undefined): void {
      mirrorText = pendingText;
      mirrorSeq = typeof seq === 'number' ? seq : -1;
    },
    get docText() { return doc; },
    get mirror() { return mirrorText; },
    get resyncs() { return resyncsRequested; },
    get fullPushes() { return fullPushesRequested; },
    get diffPayload() { return diffPayload; },
    get fullPayload() { return fullPayload; },
    get pushDiffPayload() { return pushDiffPayload; },
    get pushFullPayload() { return pushFullPayload; },
  };
}

// rebuildFromEditDiff — every refusal is TOTAL: a questionable diff must never
// be spliced in at guessed offsets.
{
  const base = 'hello world';
  eq('p8: clean splice', rebuildFromEditDiff(base, { start: 6, oldEnd: 11, newText: 'there', baseLength: 11 }), 'hello there');
  eq('p8: pure insert', rebuildFromEditDiff(base, { start: 5, oldEnd: 5, newText: ',', baseLength: 11 }), 'hello, world');
  eq('p8: pure delete', rebuildFromEditDiff(base, { start: 5, oldEnd: 11, newText: '', baseLength: 11 }), 'hello');
  eq('p8: refuse on baseLength mismatch (mirror describes another document)', rebuildFromEditDiff(base, { start: 0, oldEnd: 1, newText: 'H', baseLength: 10 }), null);
  eq('p8: refuse when oldEnd runs past the base', rebuildFromEditDiff(base, { start: 0, oldEnd: 99, newText: 'x', baseLength: 11 }), null);
  eq('p8: refuse inverted offsets', rebuildFromEditDiff(base, { start: 5, oldEnd: 2, newText: 'x', baseLength: 11 }), null);
  eq('p8: refuse negative start', rebuildFromEditDiff(base, { start: -1, oldEnd: 3, newText: 'x', baseLength: 11 }), null);
  eq('p8: refuse non-integer offsets', rebuildFromEditDiff(base, { start: 1.5, oldEnd: 3, newText: 'x', baseLength: 11 }), null);
  eq('p8: empty base, pure insert', rebuildFromEditDiff('', { start: 0, oldEnd: 0, newText: 'new', baseLength: 0 }), 'new');
  // A message boundary: a dropped/malformed newText must be refused, never
  // concatenated — otherwise the literal "undefined" lands in the user's file.
  eq(
    'p8: refuse a non-string newText instead of splicing "undefined"',
    rebuildFromEditDiff(base, { start: 0, oldEnd: 0, newText: undefined as unknown as string, baseLength: 11 }),
    null
  );
}

// Steady-state typing: the document tracks every keystroke, and the wire carries
// the edit rather than the document.
{
  const big = '# Title\n\n' + 'lorem ipsum dolor sit amet. '.repeat(200);
  const p = makeP8Pair(big);
  p.wv.type(big + 'a');
  p.wv.type(big + 'ab');
  p.wv.type(big + 'abc');
  eq('p8: typing lands byte-identical in the document', p.docText, big + 'abc');
  check('p8: zero resyncs on the happy path', p.resyncs === 0, `  resyncs=${p.resyncs}`);
  // The whole point of the finding: payload is O(edit), not O(document).
  check(
    'p8: 3 keystrokes cost 3 wire chars, not 3 documents',
    p.diffPayload === 3 && p.fullPayload === 0,
    `  diff=${p.diffPayload} full=${p.fullPayload} doc=${big.length}`
  );
}

// The divergence the rev check exists for: a push the webview DEFERRED (trigger
// popup owns the keyboard). Length alone cannot see it — here the deferred text
// is exactly as long as what the webview holds, so a baseLength-only guard would
// have spliced into the wrong base and corrupted the file.
{
  const p = makeP8Pair('AAA\n');
  p.hostPush('BBB\n', /* defer */ true); // same length, different content
  check('p8[defer]: webview did NOT adopt the deferred rev', p.wv.appliedRev === 1 && p.wv.pending !== undefined);
  p.wv.type('AAAX\n'); // local edit on the pre-push text
  check('p8[defer]: stale-base diff is refused → one resync', p.resyncs === 1, `  resyncs=${p.resyncs}`);
  eq('p8[defer]: resync heals the document to what the webview holds', p.docText, 'AAAX\n');
  // Converged: the full-text reply re-anchored the mirror, so typing is diffs again.
  p.wv.type('AAAXY\n');
  check('p8[defer]: back to diffs after the resync', p.resyncs === 1, `  resyncs=${p.resyncs}`);
  eq('p8[defer]: still byte-exact', p.docText, 'AAAXY\n');
}

// The deferred update finally renders → the webview jumps to that rev, which the
// host has since re-anchored away from. One resync, then converged again.
{
  const p = makeP8Pair('AAA\n');
  p.hostPush('BBB\n', true);
  p.wv.flushPending(); // popup released, nothing local happened → render it
  check('p8[defer-flush]: rev adopted only once actually rendered', p.wv.appliedRev === 2);
  p.wv.type('BBBZ\n');
  eq('p8[defer-flush]: document follows the webview', p.docText, 'BBBZ\n');
}

// The equal-text push. This is the branch that keeps steady-state typing on
// diffs: without adopting the rev, the webview sits behind the host's mirror
// forever and every keystroke costs a full resync — P-8's own benefit reverting
// silently, with no test failing.
{
  const p = makeP8Pair('SAME\n');
  p.hostPush('SAME\n'); // host echoes text the webview already holds
  check('p8[echo]: an identical-text push is still adopted as the new rev', p.wv.appliedRev === 2);
  p.wv.type('SAME!\n');
  check('p8[echo]: so the next keystroke stays a diff, no resync', p.resyncs === 0, `  resyncs=${p.resyncs}`);
  eq('p8[echo]: and lands byte-exact', p.docText, 'SAME!\n');
}

// A deferred update that a LATER equal-text push has made stale. Dropping it is
// what stops `appliedRev` from moving backwards on release.
{
  const p = makeP8Pair('X\n');
  p.hostPush('A\n', /* defer */ true); // rev 2, queued behind the popup
  // rev 3 is diff-shaped and stamped baseRev 2 — the rev the DEFERRED push
  // anchored the mirror to, which the webview never adopted. So the reverse-half
  // rev gate refuses it and asks for a full push; rev 4 is that push, and it is
  // the one that reaches the equal-text branch.
  p.hostPush('X\n');
  check('p8[stale-pending]: the diff push against the un-adopted rev is refused', p.fullPushes === 1, `  fullPushes=${p.fullPushes}`);
  check('p8[stale-pending]: the full re-push is adopted as the new rev', p.wv.appliedRev === 4);
  check('p8[stale-pending]: and discards the queued older update', p.wv.pending === undefined);
  p.wv.flushPending(); // popup releases — nothing left to render
  check('p8[stale-pending]: appliedRev never regresses to the stale rev', p.wv.appliedRev === 4);
  eq('p8[stale-pending]: the stale text is never rendered', p.wv.currentText, 'X\n');
  p.wv.type('XY\n');
  check('p8[stale-pending]: typing continues as a diff', p.resyncs === 0, `  resyncs=${p.resyncs}`);
  eq('p8[stale-pending]: document follows the webview', p.docText, 'XY\n');
}

// A CRLF document: the webview diffs in its own all-LF space, the host still
// writes CRLF (applyMinimalEdit's normalizeEol is downstream of P-8).
{
  const p = makeP8Pair('# A\r\n\r\nB\r\n', true);
  p.wv.type('# A\n\nB!\n'); // serialize() is always LF
  eq('p8[crlf]: document stays CRLF through a diff-shaped edit', p.docText, '# A\r\n\r\nB!\r\n');
}

// Two 'edit's in the SAME frame (invokeAction: flush of pending typing + the
// action's own sync) — the second diff's base is the first's result, so they
// must reconstruct in arrival order.
{
  const p = makeP8Pair('one\n');
  p.wv.type('one two\n');
  p.wv.type('one two three\n');
  eq('p8: same-frame edits reconstruct in order', p.docText, 'one two three\n');
  check('p8: same-frame edits need no resync', p.resyncs === 0);
}

// Fuzz: against a sequence of arbitrary rewrites, the diff protocol must land
// exactly where a pre-P-8 full-text send would have.
{
  const alphabet = 'ab😀ữ\n #-';
  const rnd = (n: number) => Math.floor(Math.random() * n);
  const randDoc = () => {
    let s = '';
    const len = rnd(40);
    for (let i = 0; i < len; i++) {
      s += alphabet[rnd(alphabet.length)];
    }
    return s;
  };
  let mismatches = 0;
  for (let i = 0; i < 400; i++) {
    const start = randDoc();
    const p = makeP8Pair(start);
    let expected = start;
    for (let step = 0; step < 4; step++) {
      const next = randDoc();
      expected = next;
      p.wv.type(next);
    }
    if (p.docText !== expected) {
      mismatches++;
    }
  }
  check('p8[fuzz]: 400 × 4 random rewrites all land byte-exact', mismatches === 0, `  mismatches=${mismatches}`);
}

// ---------------------------------------------------------------------------
// P-8 REVERSE HALF: host→webview 'update' ships only the changed region too.
// Same bar as the forward direction — the webview must end up holding EXACTLY
// what a pre-change full-text push would have given it, and every doubt about
// the base must cost a full push rather than a splice at guessed offsets.
// ---------------------------------------------------------------------------

// The happy path: an external change (git checkout, another editor, a formatter)
// while both sides agree.
{
  const big = '# Title\n\n' + 'lorem ipsum dolor sit amet. '.repeat(200);
  const p = makeP8Pair(big);
  p.hostPush(big + 'tail\n');
  eq('p8rev: the webview holds what a full-text push would have given it', p.wv.currentText, big + 'tail\n');
  check('p8rev: and adopts the push rev', p.wv.appliedRev === 2);
  check('p8rev: no full push was needed', p.fullPushes === 0);
  check(
    'p8rev: the push cost the changed region, not the document',
    p.pushDiffPayload === 5 && p.pushFullPayload === 0,
    `  diff=${p.pushDiffPayload} full=${p.pushFullPayload} doc=${big.length}`
  );
}

// Several external changes in a row (a git checkout that touches the file
// repeatedly, a watch-mode formatter) — every one of them stays a diff.
{
  const p = makeP8Pair('a\n');
  p.hostPush('ab\n');
  p.hostPush('abc\n');
  p.hostPush('abcd\n');
  eq('p8rev[burst]: the webview tracks every push', p.wv.currentText, 'abcd\n');
  check('p8rev[burst]: 3 pushes cost 3 wire chars', p.pushDiffPayload === 3 && p.pushFullPayload === 0);
  check('p8rev[burst]: and never fell back to a full push', p.fullPushes === 0);
}

// The divergence baseSeq exists for, and the reason baseLength cannot replace it:
// an 'edit' the webview POSTED but the host has not received yet. `appliedRev` is
// unchanged (a webview-authored advance bumps no rev) and the in-flight edit is
// LENGTH-PRESERVING (overtyping a selection), so both the rev gate and a
// length-only guard would wave the diff through — straight into the wrong offsets.
{
  const p = makeP8Pair('AAAA\n');
  const held = p.wv.type('BBBB\n', /* hold */ true)!; // same length, host has not seen it
  check('p8rev[inflight]: the rev gate alone cannot see this', p.wv.appliedRev === 1);
  check('p8rev[inflight]: nor can baseLength', p.wv.currentText.length === p.mirror.length);
  p.hostPush('AAAA!\n'); // host diffs against its stale mirror
  check('p8rev[inflight]: the seq gate refuses it → one full push', p.fullPushes === 1, `  fullPushes=${p.fullPushes}`);
  eq('p8rev[inflight]: nothing was spliced into the wrong base', p.wv.currentText, 'AAAA!\n');
  // What actually happens to the held edit — stated exactly, because the obvious
  // reading is wrong: the full push bumped the rev, so this edit's `baseRev` no
  // longer matches the mirror and the host REFUSES it. The resync reply then sends
  // what the webview now holds (the pushed text), so the typed 'BBBB' is GONE.
  // That is the accepted lost-keystroke race the audit already documents for the
  // forward direction — the guarantee here is convergence, never preservation.
  p.deliver(held);
  check('p8rev[inflight]: the held edit is refused, costing one resync', p.resyncs === 1, `  resyncs=${p.resyncs}`);
  eq('p8rev[inflight]: the typed text is lost, not resurrected', p.docText, 'AAAA!\n');
  eq('p8rev[inflight]: and both sides agree on that', p.docText, p.wv.currentText);
}

// The reverse path's `baseLength` guard. It needs BOTH counters to agree, because
// `resolveUpdateText` checks rev and seq FIRST and short-circuits — so a wrong
// baseLength is only reachable through a mirror bug, not through any divergence
// the counters can see. Without this case that branch has no reverse-path cover.
{
  const p = makeP8Pair('hello\n');
  p.wv.onUpdate(
    // Counters agree; the length claim does not (base is 6, not 99).
    { type: 'update', start: 0, oldEnd: 1, newText: 'H', baseLength: 99, baseRev: 1, baseSeq: 0, rev: 2 },
    false
  );
  check('p8rev[baselength]: a wrong baseLength is refused → full push', p.fullPushes === 1);
  eq('p8rev[baselength]: and nothing was spliced', p.wv.currentText, 'hello\n');
}

// A push the webview DEFERRED (trigger popup owns the keyboard) leaves the mirror
// ahead. The NEXT push is diffed against that un-adopted text, so the rev gate has
// to refuse it — resolving a diff against the wrong base is exactly what would
// corrupt the render, and the render writes back to the file.
{
  const p = makeP8Pair('one\n');
  p.hostPush('two\n', /* defer */ true);
  check('p8rev[defer]: the deferred push is stashed, not adopted', p.wv.appliedRev === 1 && p.wv.pending !== undefined);
  p.hostPush('three\n');
  check('p8rev[defer]: the follow-up diff is refused → full push', p.fullPushes === 1, `  fullPushes=${p.fullPushes}`);
  eq('p8rev[defer]: the webview lands on the latest document', p.wv.currentText, 'three\n');
}

// The deferred diff push flushes on release: the text it resolved to at ARRIVAL
// time is what renders, and only then is its rev adopted.
{
  const p = makeP8Pair('one\n');
  p.hostPush('one two\n', /* defer */ true);
  check('p8rev[defer-flush]: rev not adopted while stashed', p.wv.appliedRev === 1);
  p.wv.flushPending();
  eq('p8rev[defer-flush]: the resolved diff text renders on release', p.wv.currentText, 'one two\n');
  check('p8rev[defer-flush]: and the rev is adopted only now', p.wv.appliedRev === 2);
  check('p8rev[defer-flush]: no full push was ever needed', p.fullPushes === 0);
}

// A malformed/corrupted diff push (a mirror bug, not a legitimate divergence):
// refused wholesale, and #content is left untouched.
{
  const p = makeP8Pair('hello\n');
  p.wv.onUpdate(
    { type: 'update', start: 0, oldEnd: 99, newText: 'x', baseLength: 6, baseRev: 1, baseSeq: 0, rev: 2 },
    false
  );
  check('p8rev[malformed]: out-of-range offsets are refused → full push', p.fullPushes === 1);
  eq('p8rev[malformed]: the webview text was never touched by the bad diff', p.wv.currentText, 'hello\n');
}

// undo/redo: pendingSeq is what keeps the post-undo push a diff. Without it the
// mirror knows the text but claims a stale advance count, and every push after an
// undo would ship the whole document for nothing.
{
  const p = makeP8Pair('start\n');
  const pendingText = 'start typed\n';
  p.wv.type(pendingText, /* hold */ true); // takePendingSync: advanced, no 'edit' sent
  // case 'undo' mirrors the pending text AND its seq at message receipt.
  p.mirrorPending(pendingText, p.wv.localSeq);
  p.hostPush('start\n'); // the post-undo state
  check('p8rev[undo]: the post-undo push stayed a diff', p.fullPushes === 0, `  fullPushes=${p.fullPushes}`);
  eq('p8rev[undo]: and the webview shows the undone text', p.wv.currentText, 'start\n');
}

// The same undo, with pendingSeq dropped on the wire. The mirror must refuse to
// claim agreement (-1 never equals a real localSeq) rather than authorize a diff
// against the pre-flush text.
{
  const p = makeP8Pair('start\n');
  const pendingText = 'start typed\n';
  p.wv.type(pendingText, true);
  p.mirrorPending(pendingText, undefined); // malformed message: text without its seq
  p.hostPush('start\n');
  // The sentinel is CONSULTED, not merely stored: a diff stamped with it would be
  // refused for certain, so the push goes full-text directly. Spending a refusal
  // round trip first would be the same outcome for three messages instead of one.
  check('p8rev[undo-noseq]: no refusal round trip is spent', p.fullPushes === 0, `  fullPushes=${p.fullPushes}`);
  check('p8rev[undo-noseq]: the push went full-text directly', p.pushDiffPayload === 0 && p.pushFullPayload > 0);
  eq('p8rev[undo-noseq]: still lands on the right text', p.wv.currentText, 'start\n');
}

// A refused push must not silently become a caret-less one. Only undo/redo sends a
// caret, and it is now diff-shaped, so without the replay a refused undo lands the
// caret at applyDocumentUpdate's pre-render snapshot instead of at the undone edit.
{
  const p = makeP8Pair('one\n');
  p.hostPush('two\n', /* defer */ true); // leaves the mirror anchored ahead
  p.hostPush('three\n', false, /* caret line */ 1); // undo-shaped: diff + caret
  check('p8rev[caret]: the caret-carrying diff was refused', p.fullPushes === 1, `  fullPushes=${p.fullPushes}`);
  eq('p8rev[caret]: and the healing full push replayed its caret', p.wv.lastCaret, 1);
  eq('p8rev[caret]: on the right text', p.wv.currentText, 'three\n');
}

// A CRLF document. KNOWN LIMITATION, measured here rather than left to be
// discovered: the mirror holds whatever the webview last reported, and the webview
// serializes in LF, so after ANY local edit the mirror is LF while every push is
// CRLF. The diff then splits at the first newline and carries essentially the whole
// document — correct (both sides agree on the LF base, so baseLength holds), but
// the reverse half buys nothing on a CRLF document until the next full re-anchor.
// Reconciling the eol across the mirror boundary is a design change, not a patch.
{
  const p = makeP8Pair('# A\r\n\r\nB\r\n', true);
  p.hostPush('# A\r\n\r\nB!\r\n');
  eq('p8rev[crlf]: the webview holds the CRLF text a full push would have sent', p.wv.currentText, '# A\r\n\r\nB!\r\n');
  check('p8rev[crlf]: a push against a CRLF mirror is a real diff', p.fullPushes === 0 && p.pushDiffPayload === 1);

  const q = makeP8Pair('# A\r\n\r\nB\r\n', true);
  q.wv.type('# A\n\nB\n'); // serialize() is LF — the mirror is now LF too
  const before = q.pushDiffPayload;
  q.hostPush('# A\r\n\r\nB!\r\n');
  eq('p8rev[crlf]: still byte-exact after the eol mismatch', q.wv.currentText, '# A\r\n\r\nB!\r\n');
  check(
    'p8rev[crlf]: but the diff degenerates to ~the whole document (known limitation)',
    q.pushDiffPayload - before > 'B!'.length,
    `  pushed=${q.pushDiffPayload - before} chars vs doc=${'# A\r\n\r\nB!\r\n'.length}`
  );
}

// Fuzz: arbitrary interleavings of host pushes and webview edits must leave the
// webview holding exactly what full-text pushes would have given it, and the
// document self-consistent with it — refusals included.
{
  const alphabet = 'ab😀ữ\n #-';
  const rnd = (n: number) => Math.floor(Math.random() * n);
  const randDoc = () => {
    let s = '';
    const len = rnd(30);
    for (let i = 0; i < len; i++) {
      s += alphabet[rnd(alphabet.length)];
    }
    return s;
  };
  let mismatches = 0;
  let divergences = 0;
  let diffPushChars = 0;
  for (let i = 0; i < 400; i++) {
    const p = makeP8Pair(randDoc());
    let lastPush: string | undefined;
    // A LIST, not one slot: `held ?? …` would advance currentText/localSeq while
    // dropping the message, so two in-flight edits — the shape invokeAction really
    // produces (two 'edit's in one frame) — was unreachable.
    const held: Array<WebviewToHost & { type: 'edit' }> = [];
    for (let step = 0; step < 6; step++) {
      const next = randDoc();
      switch (rnd(4)) {
        case 0: // an external change
          lastPush = next;
          p.hostPush(next);
          break;
        case 1: { // local typing that reaches the host
          // Queue then drain: postMessage is FIFO, so an edit can never overtake an
          // older one still in flight. Calling p.wv.type(next) directly here would
          // deliver this edit ahead of the queue — an interleaving the real channel
          // cannot produce, and one that trips the forward direction's documented
          // baseLength-only footgun, reporting a model artifact as a defect.
          const msg = p.wv.type(next, true);
          if (msg) {
            held.push(msg);
          }
          while (held.length > 0) {
            p.deliver(held.shift()!);
          }
          lastPush = undefined;
          break;
        }
        case 2: { // local typing still in flight when the next push is composed
          const msg = p.wv.type(next, true);
          if (msg) {
            held.push(msg);
          }
          lastPush = undefined;
          break;
        }
        default: { // deliver the oldest held edit, in the order it was posted
          const msg = held.shift();
          if (msg) {
            p.deliver(msg);
          }
          break;
        }
      }
    }
    // A push is the last word on the webview's text: it renders (or refuses and
    // takes the full re-push of the same document), so the webview must hold it.
    if (lastPush !== undefined && p.wv.currentText !== lastPush) {
      mismatches++;
    }
    // The harm a "final text matches the last push" check cannot see: the DOCUMENT
    // drifting from what the webview shows. Only assertable with nothing in flight
    // — an undelivered edit legitimately leaves the document behind.
    if (held.length === 0 && p.docText !== p.wv.currentText) {
      divergences++;
    }
    diffPushChars += p.pushDiffPayload;
  }
  check('p8rev[fuzz]: 400 × 6 random push/edit interleavings land byte-exact', mismatches === 0, `  mismatches=${mismatches}`);
  check('p8rev[fuzz]: document never drifts from the webview once nothing is in flight', divergences === 0, `  divergences=${divergences}`);
  // Without this, a regression that refuses EVERY diff stays green — the full
  // re-push always re-establishes the text the other two checks look at.
  check('p8rev[fuzz]: and diffs were actually exercised, not refused throughout', diffPushChars > 0, `  diffChars=${diffPushChars}`);
}

// ---------------------------------------------------------------------------
// normalizeForSearch
// ---------------------------------------------------------------------------

eq('norm: bỏ dấu tiếng Việt', normalizeForSearch('Đăng ký sự kiện'), 'dang-ky-su-kien');
eq('norm: đ → d', normalizeForSearch('đường Đỏ'), 'duong-do');
eq('norm: ký tự đặc biệt → "-" và trim', normalizeForSearch('  Hello, World!!  '), 'hello-world');
eq('norm: chỉ ký tự đặc biệt → rỗng', normalizeForSearch('___!!!'), '');
eq('norm: giữ số', normalizeForSearch('Bản 2 (final)'), 'ban-2-final');
eq('norm: gộp nhiều ký tự phân tách liền nhau', normalizeForSearch('a---b...c'), 'a-b-c');

// ---------------------------------------------------------------------------
// relativePath
// ---------------------------------------------------------------------------

eq('rel: cùng thư mục', relativePath('/w/docs', '/w/docs/a.md'), 'a.md');
eq('rel: xuống thư mục con', relativePath('/w/docs', '/w/docs/sub/a.md'), 'sub/a.md');
eq('rel: đi lên một cấp', relativePath('/w/docs/sub', '/w/docs/a.md'), '../a.md');
eq('rel: đi lên nhiều cấp', relativePath('/w/a/b/c', '/w/x.md'), '../../../x.md');
eq('rel: khác nhánh', relativePath('/w/a/b', '/w/c/d/e.md'), '../../c/d/e.md');
eq('rel: from là gốc', relativePath('/', '/w/a.md'), 'w/a.md');

// relativePath case-fold (X-8) — chỉ fold khi so khớp prefix, output GIỮ casing gốc.
// Default (case-sensitive) giữ nguyên hành vi Linux/byte-identical.
eq('rel[X-8]: default không fold — C: vs c: khác nhánh',
  relativePath('/C:/Proj/docs', '/c:/Proj/assets/img.png'),
  '../../../c:/Proj/assets/img.png');
eq('rel[X-8]: caseInsensitive fold C:/c: → path đúng, giữ casing gốc của target',
  relativePath('/C:/Proj/docs', '/c:/Proj/assets/img.png', true),
  '../assets/img.png');
eq('rel[X-8]: fold lệch case ở nhánh giữa',
  relativePath('/Users/h/Proj/Docs', '/users/h/proj/Assets/x.png', true),
  '../Assets/x.png');
eq('rel[X-8]: fold nhưng output vẫn nguyên hoa/thường segment cuối',
  relativePath('/w/a', '/W/A/Report.PDF', true),
  'Report.PDF');
eq('rel[X-8]: caseInsensitive không đổi kết quả khi đã cùng case',
  relativePath('/w/docs', '/w/docs/sub/a.md', true),
  'sub/a.md');

// ---------------------------------------------------------------------------
// normalizeCustomFolderPath (X-8) — chuẩn hoá setting customFolderPath khi đọc
// ---------------------------------------------------------------------------

eq('normCFP: backslash → forward-slash', normalizeCustomFolderPath('c:\\users\\h\\assets'), 'c:/users/h/assets');
eq('normCFP: bỏ separator cuối', normalizeCustomFolderPath('c:/a/b/'), 'c:/a/b');
eq('normCFP: bỏ nhiều separator cuối + trim', normalizeCustomFolderPath('  assets\\\\  '), 'assets');
eq('normCFP: idempotent', normalizeCustomFolderPath(normalizeCustomFolderPath('C:\\A\\B\\')), 'C:/A/B');
eq('normCFP: rỗng', normalizeCustomFolderPath('   '), '');
// Drive-root / POSIX-root must survive the trailing-separator strip, else a bare
// `c:` is misread as a relative folder named "c:" inside the workspace (review).
eq('normCFP: drive-root c:\\ giữ được là c:/', normalizeCustomFolderPath('c:\\'), 'c:/');
eq('normCFP: drive-root c:/ giữ nguyên', normalizeCustomFolderPath('c:/'), 'c:/');
eq('normCFP: gõ bare drive c: → thành c:/', normalizeCustomFolderPath('c:'), 'c:/');
eq('normCFP: POSIX root / giữ nguyên', normalizeCustomFolderPath('/'), '/');

// ---------------------------------------------------------------------------
// driveMismatchHint (X-8) — gợi ý cụ thể khi custom folder khác ổ đĩa
// ---------------------------------------------------------------------------

eq('driveHint: khác ổ đĩa (Windows) → nêu D: vs C:',
  driveMismatchHint('d:/assets', '/c:/Proj'),
  ' It is on drive D: but the workspace is on drive C:; choose a folder on the same drive.');
eq('driveHint: cùng ổ đĩa (khác case) → rỗng',
  driveMismatchHint('C:/Proj/assets', '/c:/Proj'), '');
eq('driveHint: custom có drive, workspace không (path Windows trên macOS) → nêu là Windows path',
  driveMismatchHint('c:/users/x/assets', '/Users/h/Proj'),
  ' It looks like a Windows path (drive C:) that is not inside this workspace.');
eq('driveHint: cả hai không có drive → rỗng',
  driveMismatchHint('/Users/h/other', '/Users/h/Proj'), '');

// ---------------------------------------------------------------------------
// sameDocumentUri (X-8) — loại trừ file đang mở khỏi gợi ý, fold trên FS không phân biệt hoa thường
// ---------------------------------------------------------------------------

eq('sameUri: fold=false, khác case → KHÔNG bằng',
  sameDocumentUri('file:///w/Doc.md', 'file:///w/doc.md', false), false);
eq('sameUri: fold=true, khác case → bằng (cùng file trên FS không phân biệt hoa thường)',
  sameDocumentUri('file:///w/Doc.md', 'file:///w/doc.md', true), true);
eq('sameUri: fold=true, thật sự khác file → KHÔNG bằng',
  sameDocumentUri('file:///w/a.md', 'file:///w/b.md', true), false);
eq('sameUri: fold=false, trùng khít → bằng',
  sameDocumentUri('file:///w/a.md', 'file:///w/a.md', false), true);

// ---------------------------------------------------------------------------
// imageNamePrefix — prefix tên ảnh dán (C4: dọn ảnh mồ côi khi save)
// ---------------------------------------------------------------------------

eq('prefix: basename thường', imageNamePrefix('Requirement Doc'), 'requirement-doc');
eq('prefix: bỏ dấu tiếng Việt như normalizeForSearch', imageNamePrefix('Đăng ký sự kiện'), 'dang-ky-su-kien');
eq('prefix: chỉ ký tự CJK → rỗng (fallback không prefix)', imageNamePrefix('日本語'), '');
check('prefix: giới hạn độ dài 40 ký tự', imageNamePrefix('a'.repeat(100)).length === 40);

// X-21: default (caseInsensitive) lowercases as before; on a case-sensitive FS
// case is preserved so `Report` and `report` no longer alias to one prefix.
eq('prefix X-21: mặc định caseInsensitive → lowercase như cũ', imageNamePrefix('Report'), 'report');
eq('prefix X-21: caseInsensitive=true tường minh → lowercase', imageNamePrefix('Report', true), 'report');
eq('prefix X-21: case-sensitive → giữ hoa', imageNamePrefix('Report', false), 'Report');
check('prefix X-21: case-sensitive không alias Report vs report',
  imageNamePrefix('Report', false) !== imageNamePrefix('report', false));
eq('prefix X-21: case-sensitive vẫn bỏ dấu (đ/Đ→d/D, giữ hoa)',
  imageNamePrefix('Đăng Ký', false), 'Dang-Ky');
// normalizeForSearch output must stay byte-identical after the core extraction.
eq('normalizeForSearch: bất biến sau tách core (hoa+dấu)', normalizeForSearch('Đăng Ký Sự Kiện'), 'dang-ky-su-kien');
eq('normalizeForSearch: bất biến (ký tự đặc biệt)', normalizeForSearch('A_B[1]*C'), 'a-b-1-c');

// ---------------------------------------------------------------------------
// orphanAssetNames (X-1) — orphan-cleanup classifier. A tracked asset whose
// on-disk name is percent-encoded / NFC≠NFD in the .md href must NOT be seen
// as orphan and hard-deleted. Compares normalized basenames, not substrings.
// ---------------------------------------------------------------------------

// Diacritic + space + parens: dropped `Tài liệu (2).pdf` → encoded href. Kept.
eq(
  'orphan: diacritic+space+parens encoded href → referenced (kept)',
  orphanAssetNames(['Tài liệu (2).pdf'], '[x](assets/T%C3%A0i%20li%E1%BB%87u%20%282%29.pdf)'),
  [],
);
// `&` force-encoded to %26 by encodeLinkPath. Kept.
eq(
  'orphan: & in name (%26) → referenced (kept)',
  orphanAssetNames(['R&D.png'], '![x](assets/R%26D.png)'),
  [],
);
// macOS dir entry is NFD, typed link is NFC — same file, must match.
eq(
  'orphan: NFD on-disk vs NFC href → referenced (kept)',
  orphanAssetNames(['Đăng.png'.normalize('NFD')], '[x](assets/Đăng.png)'.normalize('NFC')),
  [],
);
// Genuinely unreferenced → still deleted (no hoarding regression).
eq(
  'orphan: unreferenced name → orphan (deleted)',
  orphanAssetNames(['old.png'], '[keep](assets/new.png)'),
  ['old.png'],
);
// Basename set, not substring: `img.png` must not be spared by `myimg.png`.
eq(
  'orphan: substring false-match guard (img.png vs myimg.png)',
  orphanAssetNames(['img.png'], '[x](assets/myimg.png)'),
  ['img.png'],
);
// Malformed percent in the raw pool name → guarded decode keeps it; converges.
eq(
  'orphan: malformed % in name → referenced (kept, no throw)',
  orphanAssetNames(['50%off.png'], '[x](assets/50%25off.png)'),
  [],
);
// Display text repeating the raw name must NOT keep the file — only the target.
eq(
  'orphan: reference is the target, not display text',
  orphanAssetNames(['gone.png'], '[gone.png](assets/other.png)'),
  ['gone.png'],
);
// referencedAssetBasenames: <angle> target and " title" suffix are tolerated.
eq(
  'orphan: angle-bracket target + title parsed to basename',
  [...referencedAssetBasenames('[x](<assets/a b.png> "t")')],
  ['a b.png'],
);
// normalizeAssetName: case-fold only when caseInsensitive is set.
eq('orphan: normalizeAssetName folds case when asked', normalizeAssetName('Report.PNG', true), 'report.png');
eq('orphan: normalizeAssetName keeps case by default', normalizeAssetName('Report.PNG', false), 'Report.PNG');
// Case-insensitive FS: differently-cased href still spares the file.
eq(
  'orphan: case-insensitive fold → Report.png kept by report.png href',
  orphanAssetNames(['Report.png'], '[x](assets/report.png)', true),
  [],
);
// Pasted/sized image is stored as raw <img src width> HTML, not markdown — must
// still be recognized as referenced (else hard-deleted on next save).
eq(
  'orphan: <img src width> HTML reference → kept',
  orphanAssetNames(['doc-pasted-image-abc.png'], '<img src="assets/doc-pasted-image-abc.png" alt="" width="800">'),
  [],
);
// Table-cell drop uses style="width:100%" — same raw-HTML path.
eq(
  'orphan: <img src style> (table cell) → kept',
  orphanAssetNames(['x-pasted-image-y.png'], '<img src="assets/x-pasted-image-y.png" alt="" style="width:100%">'),
  [],
);
// <a href> to a tracked file is a reference too.
eq(
  'orphan: <a href> HTML reference → kept',
  orphanAssetNames(['file.pdf'], '<a href="assets/file.pdf">doc</a>'),
  [],
);
// Linked image [![](inner)](outer): BOTH targets must be captured.
eq(
  'orphan: nested linked image captures inner + outer',
  orphanAssetNames(['inner.png', 'outer.png'], '[![a](assets/inner.png)](assets/outer.png)'),
  [],
);
// Reference-style definition [label]: target.
eq(
  'orphan: reference-style definition → kept',
  orphanAssetNames(['ref.png'], '[r]: assets/ref.png'),
  [],
);
// Dropped name with a literal, valid-hex %NN: on-disk name is NOT decoded, so
// it converges with the href (encodeLinkPath emitted %2520 → decodes to %20).
eq(
  'orphan: literal %20 in dropped name → kept (pool side not decoded)',
  orphanAssetNames(['report%20final.pdf'], '[x](assets/report%2520final.pdf)'),
  [],
);

// ---------------------------------------------------------------------------
// sanitizeDroppedFileName (US-17.6, M4) — client-controlled File.name must
// not be trusted as a filesystem path when saving a dropped file to assets/.
// ---------------------------------------------------------------------------
eq('dropFileName: tên bình thường giữ nguyên', sanitizeDroppedFileName('report.pdf'), 'report.pdf');
check(
  'dropFileName: path traversal bị trung hoà (không còn dấu / nào, không thể đi lên thư mục cha)',
  !sanitizeDroppedFileName('../../etc/passwd').includes('/')
);
check(
  'dropFileName: backslash (Windows-style) cũng bị trung hoà',
  !sanitizeDroppedFileName('..\\..\\secrets.txt').includes('\\')
);
eq('dropFileName: dấu chấm dẫn đầu (hidden file / thư mục hiện tại) bị bỏ', sanitizeDroppedFileName('.htaccess'), 'htaccess');
eq('dropFileName: rỗng sau khi làm sạch → fallback "file"', sanitizeDroppedFileName('...'), 'file');
eq('dropFileName: rỗng ngay từ đầu → fallback "file"', sanitizeDroppedFileName(''), 'file');
// Review fix (step-04, edge case hunter finding, confirmed by direct execution):
// khoảng trắng đứng TRƯỚC dấu chấm dẫn đầu từng vô hiệu hoá bước strip (trim()
// chạy sau bước strip leading-dot nên dấu chấm chưa ở vị trí 0 khi bước đó chạy).
eq(
  'dropFileName: khoảng trắng đứng trước dấu chấm dẫn đầu vẫn bị bỏ đúng',
  sanitizeDroppedFileName(' .htaccess'),
  'htaccess'
);
eq(
  'dropFileName: nhiều khoảng trắng + nhiều dấu chấm dẫn đầu đều bị bỏ',
  sanitizeDroppedFileName('  ..secret'),
  'secret'
);

// X-9 — a 100+ char browser-supplied name crosses MAX_PATH under a long
// OneDrive root; the stem is capped, the extension preserved.
eq(
  'dropFileName[X-9]: stem dài bị cắt còn 60 ký tự, giữ nguyên đuôi',
  sanitizeDroppedFileName('a'.repeat(120) + '.pdf'),
  'a'.repeat(60) + '.pdf'
);
eq(
  'dropFileName[X-9]: tên ngắn không bị đụng vào',
  sanitizeDroppedFileName('short-report.pdf'),
  'short-report.pdf'
);
eq(
  'dropFileName[X-9]: không có đuôi → toàn bộ là stem, cắt còn 60',
  sanitizeDroppedFileName('b'.repeat(80)),
  'b'.repeat(60)
);
eq(
  'dropFileName[X-9]: dấu chấm ở đầu (đuôi giả) vẫn được cắt như stem',
  sanitizeDroppedFileName('c'.repeat(70) + '.tar.gz'),
  'c'.repeat(60) + '.gz'
);

// S-6 — Windows reserved device names (CON/PRN/AUX/NUL/COM1-9/LPT1-9) and
// trailing dots/spaces, which Windows silently drops from the final path
// component.
eq('dropFileName[S-6]: reserved stem không đuôi được prefix "_"', sanitizeDroppedFileName('CON'), '_CON');
eq('dropFileName[S-6]: reserved stem có đuôi vẫn được prefix "_"', sanitizeDroppedFileName('CON.pdf'), '_CON.pdf');
eq(
  'dropFileName[S-6]: so khớp không phân biệt hoa/thường',
  sanitizeDroppedFileName('com1.PDF'),
  '_com1.PDF'
);
eq('dropFileName[S-6]: NUL/LPT9 cũng được prefix', sanitizeDroppedFileName('lpt9'), '_lpt9');
eq(
  'dropFileName[S-6]: chỉ khớp NGUYÊN stem, không khớp một phần ("bacon.pdf" giữ nguyên)',
  sanitizeDroppedFileName('bacon.pdf'),
  'bacon.pdf'
);
// Review fix (step-04, blind hunter finding): tên có ĐUÔI GHÉP (nhiều dấu
// chấm) — Windows chặn theo đoạn TRƯỚC DẤU CHẤM ĐẦU TIÊN, không phải đoạn
// trước dấu chấm cuối mà bước tách "hasExt" ở trên dùng.
eq(
  'dropFileName[S-6]: đuôi ghép, đoạn đầu trùng reserved name vẫn được prefix',
  sanitizeDroppedFileName('aux.spec.ts'),
  '_aux.spec.ts'
);
eq(
  'dropFileName[S-6]: đuôi ghép khác (.tar.gz), đoạn đầu trùng reserved name vẫn được prefix',
  sanitizeDroppedFileName('con.tar.gz'),
  '_con.tar.gz'
);
eq('dropFileName[S-6]: dấu chấm ở cuối bị bỏ', sanitizeDroppedFileName('notes.'), 'notes');
eq('dropFileName[S-6]: khoảng trắng ở cuối bị bỏ', sanitizeDroppedFileName('notes.pdf '), 'notes.pdf');
eq(
  'dropFileName[S-6]: chuỗi dấu chấm/khoảng trắng hỗn hợp ở cuối đều bị bỏ',
  sanitizeDroppedFileName('notes. . '),
  'notes'
);

// X-9 — path-length failures are recognized so a specific message can name
// MAX_PATH / LongPathsEnabled instead of a generic "Failed to save".
check('pathTooLong[X-9]: ENAMETOOLONG code', isPathTooLongError({ code: 'ENAMETOOLONG' }));
check('pathTooLong[X-9]: ERROR_PATH_NOT_FOUND code', isPathTooLongError({ code: 'ERROR_PATH_NOT_FOUND' }));
check('pathTooLong[X-9]: message text', isPathTooLongError(new Error('ENAMETOOLONG: name too long')));
check('pathTooLong[X-9]: lỗi thường không khớp', !isPathTooLongError({ code: 'EACCES' }));
check('pathTooLong[X-9]: null an toàn', !isPathTooLongError(null));

// ---------------------------------------------------------------------------
// classifyLink — allowlist scheme
// ---------------------------------------------------------------------------

eq('link: rỗng', classifyLink(''), { kind: 'empty' });
eq('link: http hợp lệ', classifyLink('http://example.com'), { kind: 'absolute', scheme: 'http', safe: true });
eq('link: https hợp lệ', classifyLink('https://example.com'), { kind: 'absolute', scheme: 'https', safe: true });
eq('link: mailto hợp lệ', classifyLink('mailto:a@b.com'), { kind: 'absolute', scheme: 'mailto', safe: true });
eq('link: HTTPS hoa vẫn an toàn (giữ scheme gốc)', classifyLink('HTTPS://x'), { kind: 'absolute', scheme: 'HTTPS', safe: true });
eq('link: command: bị chặn', classifyLink('command:foo'), { kind: 'absolute', scheme: 'command', safe: false });
eq('link: javascript: bị chặn', classifyLink('javascript:alert(1)'), { kind: 'absolute', scheme: 'javascript', safe: false });
eq('link: file: bị chặn', classifyLink('file:///etc/passwd'), { kind: 'absolute', scheme: 'file', safe: false });
eq('link: vscode: bị chặn', classifyLink('vscode://x'), { kind: 'absolute', scheme: 'vscode', safe: false });
eq('link: đường dẫn tương đối', classifyLink('./other.md#sec'), { kind: 'relative' });
eq('link: đường dẫn tuyệt đối trong workspace (không scheme)', classifyLink('/docs/a.md'), { kind: 'relative' });
// X-7: a Windows drive path is a local target, not the unsafe scheme `c:`.
eq('link: Windows drive path backslash → local (X-7)', classifyLink('C:\\docs\\x.md'), { kind: 'relative' });
eq('link: Windows drive path forward-slash → local (X-7)', classifyLink('c:/docs/x.md'), { kind: 'relative' });
// X-7 follow-up: the REAL runtime href — markdown-it encodes `\`→`%5C`, so the
// click/marker path classifies `C:%5C…`, which must still be local, not scheme c:.
eq('link: drive path %5C-encoded (markdown-it href) → local (X-7)', classifyLink('C:%5Cdocs%5Cx.md'), { kind: 'relative' });
eq('link: drive path %2F-encoded → local (X-7)', classifyLink('C:%2Fdocs%2Fx.md'), { kind: 'relative' });

// ---------------------------------------------------------------------------
// link-scheme predicates (src/shared/link-scheme.ts) — the ONE answer for X-7
// ---------------------------------------------------------------------------

eq('drivePath: C:\\ backslash', isWindowsDrivePath('C:\\docs\\x.md'), true);
eq('drivePath: c:/ forward slash', isWindowsDrivePath('c:/docs/x.md'), true);
eq('drivePath: %5C-encoded backslash (markdown-it href) match (X-7)', isWindowsDrivePath('C:%5Cdocs%5Cx.md'), true);
eq('drivePath: %2F-encoded forward slash match (X-7)', isWindowsDrivePath('c:%2Fdocs%2Fx.md'), true);
eq('drivePath: http không phải drive', isWindowsDrivePath('http://x'), false);
eq('drivePath: bare c: (thiếu separator) không match', isWindowsDrivePath('c:foo'), false);
eq('drivePath: đường dẫn tương đối không phải drive', isWindowsDrivePath('./a.md'), false);
eq('scheme: http là scheme', hasUrlScheme('http://x'), true);
eq('scheme: mailto là scheme', hasUrlScheme('mailto:a@b'), true);
eq('scheme: drive path KHÔNG phải scheme (X-7)', hasUrlScheme('C:\\x.md'), false);
eq('scheme: %5C-encoded drive path KHÔNG phải scheme (X-7)', hasUrlScheme('C:%5Cx.md'), false);
eq('scheme: đường dẫn tương đối KHÔNG phải scheme', hasUrlScheme('./a.md'), false);
eq('scheme: anchor thuần KHÔNG phải scheme', hasUrlScheme('#heading'), false);

// X-7 (root cause B): UNC network path `\\server\share\…` is a local absolute
// target, not a URL scheme and not workspace-relative. Both 1 AND 2 leading
// backslashes must match — CommonMark's backslash-escape rule collapses a
// hand-typed `\\server\...` (2 raw chars) down to 1 backslash in the parsed
// href, so requiring exactly 2 here would never classify a naturally-authored
// UNC link as UNC (see render.ts's normalizeLink override + turndown.ts's
// linkHrefBackslashEscape rule, which together keep the doubled form stable
// across round-trips when the DOM genuinely holds 2 backslashes).
eq('unc: \\\\server\\share (2 backslash, doubled-in-DOM case) match', isWindowsUncPath('\\\\server\\share\\x.md'), true);
eq('unc: \\server\\x.md (1 backslash, hand-typed-then-CommonMark-collapsed case) match', isWindowsUncPath('\\server\\x.md'), true);
eq('unc: forward-slash //server KHÔNG phải UNC (protocol-relative URL)', isWindowsUncPath('//server/share/x.md'), false);
eq('unc: drive path không phải UNC', isWindowsUncPath('C:\\x.md'), false);
eq('unc: đường dẫn tương đối không phải UNC', isWindowsUncPath('./a.md'), false);
eq('scheme: UNC KHÔNG phải scheme', hasUrlScheme('\\\\server\\share\\x.md'), false);

// ---------------------------------------------------------------------------
// message contract (src/shared/messages.ts) — kiểm tra ở mức TYPE. Nếu hình
// dạng message đổi mà quên cập nhật, các gán dưới đây sẽ không biên dịch (tsc).
// ---------------------------------------------------------------------------

const fromWebview: WebviewToHost[] = [
  { type: 'ready' },
  // P-8: both 'edit' shapes — the steady-state diff and the full-text resync reply.
  { type: 'edit', start: 0, oldEnd: 1, newText: 'y', baseLength: 1, baseRev: 1, seq: 1 },
  { type: 'edit', text: 'x', baseRev: 1, seq: 1 },
  // P-8 reverse half: the webview's refusal reply to a diff-shaped 'update'.
  { type: 'requestFullPush' },
  { type: 'openLink', href: 'https://x' },
  { type: 'searchFiles', query: 'q', requestId: 1 },
  { type: 'copyFileMention' },
  { type: 'viewSource' },
  { type: 'crossFileSearch:request', requestId: 1, query: 'q', scope: 'markdown', matchCase: false, wholeWord: true },
  { type: 'crossFileSearch:openResult', uri: 'file:///a.md', line: 0, character: 0, length: 1, matchText: 'x' },
  { type: 'crossFileSearch:openInSearchPanel', query: 'q', scope: 'allFiles' },
  { type: 'pasteImage', requestId: 1, mime: 'image/png', dataBase64: 'AA==' },
  { type: 'dropFile', requestId: 1, name: 'report.pdf', dataBase64: 'AA==' },
  { type: 'zenChanged', zen: true },
  { type: 'readingModeChanged', enabled: true, mode: 'sepia' },
];

const readabilityFixture = {
  enabled: false, mode: 'standard',
  fontFamily: '', zen: false,
} as const;
const triggerFixture: TriggerConfig = { dateFormat: 'YYYY-MM-DD', executeCommands: [], mode: 'advanced' };
const toWebview: HostToWebview[] = [
  { type: 'init', text: 'x', rev: 1, docUri: 'file:///a.md', config: {
    breaks: false, linkify: true, wordWrap: false, fontSize: 14,
    lineHeight: 1.6, fontFamily: 'sans', autoOpenToc: true, showLineNumbers: true,
    crossFileSearchScope: 'markdown', tableFitMode: false, readability: readabilityFixture, trigger: triggerFixture,
    plantumlEngineUri: 'vscode-resource://plantuml-engine.js', scriptNonce: 'n0nce',
    mermaidEngineUri: 'vscode-resource://mermaid-engine.js',
    commentAuthorName: 'hungvu', docRelativePath: 'a.md', commentHighlightOn: false,
  } },
  { type: 'init', text: 'x', rev: 1, docUri: 'file:///a.md', config: {
    breaks: false, linkify: true, wordWrap: false, fontSize: 14,
    lineHeight: 1.6, fontFamily: 'sans', autoOpenToc: true, showLineNumbers: true,
    crossFileSearchScope: 'markdown', tableFitMode: false, readability: readabilityFixture, trigger: triggerFixture,
    plantumlEngineUri: 'vscode-resource://plantuml-engine.js', scriptNonce: 'n0nce',
    mermaidEngineUri: 'vscode-resource://mermaid-engine.js',
    commentAuthorName: 'hungvu', docRelativePath: 'a.md', commentHighlightOn: false,
  }, reveal: { line: 0, character: 0, length: 1 } },
  { type: 'update', text: 'x', rev: 2 },
  // P-8 reverse half: the diff-shaped 'update' — the same message carrying only
  // the changed region, guarded by baseRev + baseSeq.
  { type: 'update', start: 0, oldEnd: 1, newText: 'y', baseLength: 1, baseRev: 1, baseSeq: 3, rev: 2 },
  { type: 'requestFullSync' },
  { type: 'fileSearchResult', requestId: 1, files: [{ path: 'a.md', name: 'a.md', dir: '.' }] },
  { type: 'configUpdate', autoOpenToc: true, showLineNumbers: true, triggerMode: 'advanced', commentAuthorName: 'hungvu' },
  { type: 'crossFileSearch:result', requestId: 1, groups: [], truncated: false, usedFallback: false },
  { type: 'scrollToPosition', line: 0, character: 0, length: 1 },
  { type: 'pasteImageResult', requestId: 1, relativePath: 'images/a.png' },
  { type: 'dropFileResult', requestId: 1, relativePath: 'assets/report.pdf' },
  { type: 'zenChanged', zen: true },
  { type: 'readingModeChanged', enabled: true, mode: 'sepia' },
];
check('contract: WebviewToHost phủ đủ 15 biến thể (P-8 splits edit into diff + full-text; + requestFullPush)', fromWebview.length === 15);
check('contract: HostToWebview phủ đủ 13 biến thể (init có/không reveal + update diff/full + requestFullSync + scrollToPosition + pasteImage + dropFile + zenChanged + readingModeChanged)', toWebview.length === 13);

// ---------------------------------------------------------------------------
// findTextMatches (src/shared/text-match.ts) — lõi so khớp THUẦN dùng chung cho
// Ctrl+F/Feature B (webview) và host provider. Case tiếng Việt có dấu là lý do
// cấm \b/\w (chỉ nhận [A-Za-z0-9_]).
// ---------------------------------------------------------------------------

const OPT = (matchCase: boolean, wholeWord: boolean): MatchOptions => ({ matchCase, wholeWord });

// Substring, case-insensitive mặc định (matchCase:false) — query lệch hoa/thường vẫn khớp.
eq(
  'match: substring case-insensitive mặc định',
  findTextMatches('Hello WORLD hello', 'hello', OPT(false, false)),
  [{ start: 0, end: 5 }, { start: 12, end: 17 }]
);

// matchCase:true — chỉ khớp đúng hoa/thường; occurrence lệch case KHÔNG khớp.
eq(
  'match: matchCase phân biệt hoa/thường',
  findTextMatches('Editor editor EDITOR', 'editor', OPT(true, false)),
  [{ start: 7, end: 13 }]
);

// wholeWord:true — query đứng như từ trọn vẹn khớp; nằm trong từ lớn hơn thì KHÔNG.
eq(
  'match: wholeWord chỉ khớp từ trọn vẹn',
  findTextMatches('MarkdownEditor and Editor', 'Editor', OPT(false, true)),
  [{ start: 19, end: 25 }]
);

// wholeWord:false — cùng query DO khớp cả bên trong từ lớn hơn.
eq(
  'match: wholeWord tắt vẫn khớp bên trong từ lớn',
  findTextMatches('MarkdownEditor and Editor', 'Editor', OPT(false, false)),
  [{ start: 8, end: 14 }, { start: 19, end: 25 }]
);

// Ranh giới từ tiếng Việt có dấu — ĐÂY LÀ LÝ DO CẤM \b/\w. Query "ường" là
// substring của cả "đường" (đứng trước là 'đ') lẫn "trường" (đứng trước là 'r').
// 'đ' và 'r' đều là CHỮ CÁI ⇒ với ranh giới Unicode-aware, "ường" KHÔNG phải từ
// trọn vẹn ở đâu cả ⇒ wholeWord trả về RỖNG. (\b/\w naive sẽ SAI: coi 'đ' là
// ký tự non-word nên tưởng có ranh giới trước "ường" trong "đường".)
eq(
  'match: wholeWord — "đ" là ký tự từ nên "ường" không khớp (chống \\b sai)',
  findTextMatches('đường trường', 'ường', OPT(false, true)),
  []
);
// Đối chứng: wholeWord:false thì cả hai lần xuất hiện đều khớp.
eq(
  'match: substring bắt cả "ường" trong "đường" lẫn "trường"',
  findTextMatches('đường trường', 'ường', OPT(false, false)),
  [{ start: 1, end: 5 }, { start: 8, end: 12 }]
);
// "trường" như một từ trọn vẹn (giữa 2 khoảng trắng) vẫn khớp dù có dấu.
eq(
  'match: wholeWord khớp "trường" trọn vẹn (có dấu)',
  findTextMatches('đi trên trường', 'trường', OPT(false, true)),
  [{ start: 8, end: 14 }]
);
// "đường" đứng riêng (đầu chuỗi) khớp wholeWord — chứng minh nhánh find-được.
eq(
  'match: wholeWord khớp "đường" đứng riêng',
  findTextMatches('đường trường', 'đường', OPT(false, true)),
  [{ start: 0, end: 5 }]
);

// Ranh giới = mép chuỗi (không phải ký tự) — từ đầu và từ cuối vẫn khớp wholeWord.
eq(
  'match: wholeWord ở đầu chuỗi',
  findTextMatches('cat and dog', 'cat', OPT(false, true)),
  [{ start: 0, end: 3 }]
);
eq(
  'match: wholeWord ở cuối chuỗi',
  findTextMatches('a lazy dog', 'dog', OPT(false, true)),
  [{ start: 7, end: 10 }]
);

// Không chồng lấn + tôn trọng cap maxMatches.
eq(
  'match: không chồng lấn, cap maxMatches',
  findTextMatches('aaaa', 'aa', OPT(false, false), 5),
  [{ start: 0, end: 2 }, { start: 2, end: 4 }]
);
eq(
  'match: cap maxMatches cắt đúng số lượng',
  findTextMatches('x x x x', 'x', OPT(false, false), 2),
  [{ start: 0, end: 1 }, { start: 2, end: 3 }]
);

// Query rỗng ⇒ không match; wholeWord với ký tự "_" coi là ký tự từ.
eq('match: query rỗng ⇒ rỗng', findTextMatches('abc', '', OPT(false, true)), []);
eq(
  'match: "_" là ký tự từ nên foo_bar không khớp wholeWord "foo"',
  findTextMatches('foo_bar foo', 'foo', OPT(false, true)),
  [{ start: 8, end: 11 }]
);

// ---------------------------------------------------------------------------
// detectBlockStyle (US-18.4a heading axis + US-18.4b remaining axes) — detect a
// block's original syntax variant from its mdSlice. `style()` fills the all-null
// default so each case states only the axes it cares about.
// ---------------------------------------------------------------------------

function style(over: Partial<StyleOverride>): StyleOverride {
  return {
    heading: null,
    headingUnderlineLength: null,
    bullet: null,
    code: null,
    em: null,
    strong: null,
    hr: null,
    tableSeparator: null,
    ...over,
  };
}

// Heading: Setext (underline) vs ATX (#). H1 '=', H2 '-'. Underline length kept.
eq('style: Setext H1 → setext, keep length', detectBlockStyle('Title\n=====', 'heading'), style({ heading: 'setext', headingUnderlineLength: 5 }));
eq('style: Setext H2 → setext, keep length', detectBlockStyle('Title\n---', 'heading'), style({ heading: 'setext', headingUnderlineLength: 3 }));
eq('style: ATX H1 → atx', detectBlockStyle('# Title', 'heading'), style({ heading: 'atx' }));
eq('style: ATX H2 → atx', detectBlockStyle('## Title', 'heading'), style({ heading: 'atx' }));
// ATX text containing '=' or '-' must NOT be misread as Setext (single-line slice).
eq('style: ATX text with "=" → atx', detectBlockStyle('# Title = Draft', 'heading'), style({ heading: 'atx' }));
eq('style: ATX text with "-" → atx', detectBlockStyle('## Section - notes', 'heading'), style({ heading: 'atx' }));
// Heading axis not applicable to a non-heading block → null.
eq('style: paragraph → heading null', detectBlockStyle('just a paragraph', 'paragraph'), style({}));
eq('style: canonical hr block → all axes null', detectBlockStyle('---', 'hr'), style({}));

// Bullet axis: single variant, mixed markers (first wins), ordered-only → null,
// inapplicable block type → null (no crash).
eq('style: "+" list → bullet "+"', detectBlockStyle('+ one\n+ two', 'list').bullet, '+');
eq('style: "-" list → bullet "-"', detectBlockStyle('- one', 'list').bullet, '-');
eq('style: "*" list → bullet "*" (default, unstamped later)', detectBlockStyle('* one', 'list').bullet, '*');
eq('style: mixed markers → first-encountered wins', detectBlockStyle('- a\n  * b\n  + c', 'list').bullet, '-');
eq('style: purely ordered list → bullet null', detectBlockStyle('1. a\n2. b', 'list').bullet, null);
eq('style: bullet detector on heading → null', detectBlockStyle('# Title', 'heading').bullet, null);

// Code axis: single check on the first non-blank line.
eq('style: 4-space code → indented', detectBlockStyle('    line1\n    line2', 'code').code, 'indented');
eq('style: tab code → indented-tab (tabs kept on re-emit)', detectBlockStyle('\tline1', 'code').code, 'indented-tab');
eq('style: ~~~ fence → fence-tilde', detectBlockStyle('~~~js\ncode\n~~~', 'code').code, 'fence-tilde');
eq('style: backtick fence → default (null)', detectBlockStyle('```js\ncode\n```', 'code').code, null);
eq('style: code detector on paragraph → null', detectBlockStyle('    not code type', 'paragraph').code, null);

// Em/strong axes: `_`/`__` win only when encountered before `*`/`**`; backtick
// code spans are stripped before scanning; intraword `_` never counts.
eq('style: "_em_" → em "_"', detectBlockStyle('has _em_ here', 'paragraph').em, '_');
eq('style: "*em*" → em default (null)', detectBlockStyle('has *em* here', 'paragraph').em, null);
eq('style: "*a*" before "_b_" → first wins (null)', detectBlockStyle('*a* then _b_', 'paragraph').em, null);
eq('style: "__strong__" → strong "__"', detectBlockStyle('has __strong__ here', 'paragraph').strong, '__');
eq('style: "**strong**" → strong default (null)', detectBlockStyle('has **strong**', 'paragraph').strong, null);
eq('style: "_" inside code span ignored', detectBlockStyle('`_x_` only code', 'paragraph').em, null);
eq('style: intraword "_" (snake_case) ignored', detectBlockStyle('snake_case_name', 'paragraph').em, null);
eq('style: em detector on code block → null', detectBlockStyle('_not_ emphasis', 'code').em, null);

// HR axis: raw line kept verbatim (incl. legal leading indent); `---` → null.
eq('style: "***" hr → raw line kept', detectBlockStyle('***', 'hr').hr, '***');
eq('style: "___" hr → raw line kept', detectBlockStyle('___', 'hr').hr, '___');
eq('style: "- - -" hr → raw line kept', detectBlockStyle('- - -', 'hr').hr, '- - -');
eq('style: "  ***" hr → leading indent kept', detectBlockStyle('  ***', 'hr').hr, '  ***');
eq('style: hr detector on paragraph → null', detectBlockStyle('***', 'paragraph').hr, null);

// Detection hardening (US-18.4b review round): container blocks, false
// delimiter evidence, triple-delimiter runs.
eq('style: blockquoted "-" list → bullet "-"', detectBlockStyle('> - quoted\n> - more', 'blockquote').bullet, '-');
eq('style: blockquote without list → bullet null', detectBlockStyle('> plain quote', 'blockquote').bullet, null);
eq(
  'style: "- " inside fenced diff not marker evidence',
  detectBlockStyle('1. step\n\n   ```diff\n   - removed\n   ```\n\n   * sub', 'list').bullet,
  '*'
);
eq('style: "___x___" → em "_" (triple run opens em+strong)', detectBlockStyle('a ___x___ b', 'paragraph').em, '_');
eq('style: "___x___" → strong "__"', detectBlockStyle('a ___x___ b', 'paragraph').strong, '__');
eq('style: "***x***" before "_y_" → em default (null)', detectBlockStyle('***x*** then _y_', 'paragraph').em, null);
eq('style: literal "2*4" not star evidence → em "_"', detectBlockStyle('Buy 2*4 lumber and _nails_.', 'paragraph').em, '_');
eq('style: "_" in link URL not em evidence', detectBlockStyle('[doc](https://ex.com/_v2_) and *note*', 'paragraph').em, null);
eq('style: intraword "_" after non-ASCII letter ignored', detectBlockStyle('chữ_ký here and *em*', 'paragraph').em, null);
eq('style: escaped backslash before "_" → em "_"', detectBlockStyle('C:\\\\_dir_ here', 'paragraph').em, '_');
eq('style: backtick-run span strips fully → em null', detectBlockStyle('Use ``x `_foo` y`` here', 'paragraph').em, null);

// ---------------------------------------------------------------------------
// reading-stats (US-10.7) — word count (CJK char = 1 word), read-time
// estimate (200 WPM, 0 words → 0 min), hardcoded thousands separator.
// ---------------------------------------------------------------------------

eq('countWords: mixed non-CJK + CJK → 2 words + 5 chars = 7', countWords('Hello world こんにちは'), 7);
// Supplementary-plane Han (CJK Extension B, U+20000) is still one word each,
// not collapsed into a single run — a plain BMP-only regex would miss these.
eq('countWords: supplementary-plane Han counts per character', countWords(String.fromCodePoint(0x20000, 0x20001, 0x20002)), 3);
eq('estimateReadMinutes: 0 words → 0 min', estimateReadMinutes(0), 0);
eq('estimateReadMinutes: 7 words → 1 min (floor never shown for real content)', estimateReadMinutes(7), 1);
eq('formatCount: hardcoded comma, not toLocaleString', formatCount(1860), '1,860');

// ---------------------------------------------------------------------------
// Security tripwires (src/provider.ts) — khoá các bất biến từ security review
// 2026-07-17 (xem Plan/Optimization Notes.md § Security hardening). Đọc source
// dạng text vì provider.ts import 'vscode', không mock được trong test này.
// ---------------------------------------------------------------------------

const providerSrc = fs.readFileSync(path.join(process.cwd(), 'src/provider.ts'), 'utf8');

// CSP lock — mọi nới lỏng directive phải sửa test này một cách CÓ CHỦ ĐÍCH,
// không thể vô tình lọt qua.
// US-2.8: script-src thêm 'wasm-unsafe-eval' CÓ CHỦ ĐÍCH — engine PlantUML
// client-side (Viz.js = Graphviz qua Emscripten) cần biên dịch WebAssembly. Pin
// nguyên chuỗi đầy đủ chứ không chỉ phần 'nonce-...': includes() khớp chuỗi con,
// nên nếu chỉ pin phần nonce thì mọi lần nới lỏng thêm sau này đều lọt qua.
const REQUIRED_CSP_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'nonce-${nonce}' 'wasm-unsafe-eval'",
  "base-uri ${webview.cspSource}",
  "form-action 'none'",
  "frame-src 'none'",
];
for (const directive of REQUIRED_CSP_DIRECTIVES) {
  check(`security: CSP giữ directive "${directive}"`, providerSrc.includes(directive));
}
// 'wasm-unsafe-eval' chỉ cho phép biên dịch WASM. 'unsafe-eval' (bật eval()/
// new Function() cho JS) là chuyện khác hẳn và phải luôn vắng mặt — regex loại
// trừ đúng token 'wasm-unsafe-eval' để không tự khớp nhầm phần đuôi của nó.
check(
  'security: script-src KHÔNG có "unsafe-eval" (chỉ wasm-unsafe-eval mới được phép)',
  !/script-src[^\n]*(?<!wasm-)'unsafe-eval'/.test(providerSrc)
);
check(
  'security: img-src KHÔNG có "https:" (chặn ảnh remote/exfil qua .md độc hại)',
  /img-src[^\n]*data:/.test(providerSrc) && !/img-src[^\n]*https:/.test(providerSrc)
);
check(
  'security: script-src KHÔNG có "unsafe-inline" (chặn inline script tiêm từ .md)',
  !/script-src[^\n]*unsafe-inline/.test(providerSrc)
);

// Security hardening (Plan/Optimization Notes.md § Security hardening) — S-1/S-2
// đã fix: message boundary webview→host phải whitelist/gate trước khi dùng giá
// trị. Scan trực tiếp source provider.ts để bám sát fix thật.
const readingModeCaseBody =
  providerSrc.match(/case 'readingModeChanged': \{([\s\S]*?)\n        \}/)?.[1] ?? '';
check(
  'security S-1: readingModeChanged whitelist mode trước khi lưu',
  /READING_MODES/.test(readingModeCaseBody) && /msg\.mode/.test(readingModeCaseBody)
);

// Anchor vào ĐỊNH NGHĨA method (không phải chỗ gọi cùng tên đứng trước nó).
const openResultBody = providerSrc.match(/private async openCrossFileSearchResult\([\s\S]*?\n  \}/)?.[0] ?? '';
check(
  'security S-2: crossFileSearch:openResult gate qua isInsideAllowedRoots trước khi mở',
  /isInsideAllowedRoots/.test(openResultBody)
);

// Bug 1 (2026-07-18): file kéo-thả (không phải ảnh) giờ được orphan-cleanup như
// ảnh dán — saveDroppedFile phải theo dõi file, cleanupOrphanImages phải gộp tập
// theo dõi, và restore qua undo phải re-track. Scan source (host-fs, không có
// harness vscode) — cùng kiểu guard như S-1/S-2.
const saveDroppedBody = providerSrc.match(/private async saveDroppedFile\([\s\S]*?\n  \}/)?.[0] ?? '';
check('bug1: saveDroppedFile theo dõi asset để dọn khi mồ côi', /trackDroppedAsset/.test(saveDroppedBody));
const cleanupBody = providerSrc.match(/private async cleanupOrphanImages\([\s\S]*?\n  \}/)?.[0] ?? '';
check('bug1: cleanupOrphanImages gộp file kéo-thả đã theo dõi', /droppedAssetsByDoc/.test(cleanupBody));
const restoreBody = providerSrc.match(/private async restoreUndoneImageDeletions\([\s\S]*?\n  \}/)?.[0] ?? '';
check('bug1: undo khôi phục file kéo-thả re-track để dọn tiếp', /trackDroppedAsset/.test(restoreBody));

// Security Audit S-1 (2026-07-28): a repo-committed symlink below the workspace
// root passes the guard's lexical prefix check, so mutating flows could write
// or hard-delete through it outside the workspace. Fix = mutating call sites
// pass `forWrite: true` and the guard walks the segments below the matched
// root with the real-FS helper below. Lock both the wiring (source tripwires,
// same style as S-1/S-2 above) and the helper's behavior (real temp symlinks).
const resolveAllowedBody =
  providerSrc.match(/private async resolveAllowedAssetsDir\([\s\S]*?\n  \}/)?.[0] ?? '';
check(
  'security S-1(audit): resolveAllowedAssetsDir uses the write-mode guard',
  /isInsideAllowedRoots\([^)]*\{ forWrite: true \}/.test(resolveAllowedBody)
);
check(
  'security S-1(audit): sidecar write guard closure uses the write-mode guard',
  /createSidecarStore\(\s*\(docUri, target\) => provider\.isUriInsideAllowedRoots\(docUri, target, \{ forWrite: true \}\)/.test(
    providerSrc
  )
);
const allowedRootsBody = providerSrc.match(/private async isUriInsideAllowedRoots\([\s\S]*?\n  \}/)?.[0] ?? '';
check(
  'security S-1(audit): the guard consults pathSegmentsContainSymlink for writes',
  /pathSegmentsContainSymlink\(/.test(allowedRootsBody)
);
// Review finding (High): the lexical compare folds case on macOS/Windows, so a
// case-sensitive walk would abstain on a case-divergent pair and wave the write
// through — the walk must be told the same case policy.
check(
  'security S-1(audit): the symlink walk uses the same case policy as the lexical compare',
  /pathSegmentsContainSymlink\([^)]*CASE_INSENSITIVE_FS\)/.test(allowedRootsBody)
);
// Review finding (Medium): refusing on the first matching root (always the
// document's own dir) would reject writes a workspace-folder root allows, and
// would make the realpath fallback unreachable.
check(
  'security S-1(audit): every matching root is walked, refusal is not final',
  /matchedRoots\b/.test(allowedRootsBody) && !/roots\.find\(/.test(allowedRootsBody)
);

// S-1 RESIDUAL (2026-07-28): the fix above guards the assets DIRECTORY only, so
// a file-symlink at the final `assets/<name>` was still dereferenced — the leaf
// segment is never walked, and uniqueAssetUri's `stat` cannot see it (it
// follows the link, and a dangling link makes stat throw = "name is free").
// Every asset flow must run isAllowedAssetLeaf on `<dir>/<name>` first. Same
// source-tripwire style as above: the four flows are unreachable from any test
// track (no harness vscode).
const assetLeafGuardBody = providerSrc.match(/private isAllowedAssetLeaf\([\s\S]*?\n  \}/)?.[0] ?? '';
check(
  'security S-1(residual): the leaf guard measures the leaf against the already-guarded dir',
  /pathSegmentsContainSymlink\(dir\.fsPath, target\.fsPath, CASE_INSENSITIVE_FS\)/.test(assetLeafGuardBody)
);
// Review finding (High): re-running the FULL containment guard on the file uri
// instead refuses a legitimate `assets -> ../shared-assets` layout — that
// layout is accepted only by the realpath fallback, and realpath throws ENOENT
// on a file that does not exist yet, so every new paste/drop would be rejected.
check(
  'security S-1(residual): the leaf guard does not re-run the containment/realpath check',
  assetLeafGuardBody !== '' && !/isInsideAllowedRoots/.test(assetLeafGuardBody)
);
const savePastedBody = providerSrc.match(/private async savePastedImage\([\s\S]*?\n  \}/)?.[0] ?? '';
const restoreUndoneBody =
  providerSrc.match(/private async restoreUndoneImageDeletions\([\s\S]*?\n  \}/)?.[0] ?? '';
const deleteOrphanBody = providerSrc.match(/private async deleteOrphanImage\([\s\S]*?\n  \}/)?.[0] ?? '';
for (const [label, body, deref] of [
  ['savePastedImage', savePastedBody, 'fs.writeFile'],
  ['saveDroppedFile', saveDroppedBody, 'fs.writeFile'],
  ['restoreUndoneImageDeletions', restoreUndoneBody, 'fs.writeFile'],
  ['deleteOrphanImage', deleteOrphanBody, 'fs.readFile'],
] as const) {
  // Review finding (Medium): asserting only that the identifier appears before
  // the write stays green for `void this.isAllowedAssetLeaf(...)`, a dropped
  // `!`, or the DIRECTORY passed twice — i.e. for the exact bug being fixed.
  // Pin the negated call with a distinct dir and leaf argument.
  const guarded = /if \(!this\.isAllowedAssetLeaf\((\w+), (\w+)\)\)/.exec(body);
  const derefAt = body.indexOf(deref);
  check(
    `security S-1(residual): ${label} refuses a symlinked leaf before dereferencing it`,
    guarded !== null && guarded[1] !== guarded[2] && derefAt !== -1 && guarded.index < derefAt
  );
}
// Review finding (High): the bytes in recentlyDeletedImages are the only copy
// left once cleanupOrphanImages has hard-deleted the file, so a refusal must
// not evict them — the guard has to run before the cache delete, not after.
check(
  'security S-1(residual): a refused restore keeps the cached bytes for a later in-bounds retry',
  /isAllowedAssetLeaf[\s\S]*?recentlyDeletedImages\.delete\(fileName\)/.test(restoreUndoneBody)
);

// The helper itself, against a real filesystem (Node-only module, no vscode).
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-guard-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-guard-outside-'));
  try {
    fs.mkdirSync(path.join(root, 'docs', 'assets'), { recursive: true });
    check(
      'fs-guard: plain nested dir below the root is symlink-free',
      pathSegmentsContainSymlink(root, path.join(root, 'docs', 'assets')) === false
    );
    check(
      'fs-guard: target equal to the root is safe (root itself never checked)',
      pathSegmentsContainSymlink(root, root) === false
    );
    check(
      'fs-guard: not-yet-created assets dir is safe (first paste creates it)',
      pathSegmentsContainSymlink(root, path.join(root, 'docs', 'new', 'assets')) === false
    );
    check(
      'fs-guard: target outside the root abstains (containment is the caller\'s check)',
      pathSegmentsContainSymlink(root, outside) === false
    );
    // Kept outside the symlink block below: a host without symlink privilege
    // must still prove that an ordinary new asset name is allowed.
    const assetsDir = path.join(root, 'docs', 'assets');
    check(
      'fs-guard: an ordinary not-yet-written leaf file stays allowed',
      pathSegmentsContainSymlink(assetsDir, path.join(assetsDir, 'fresh.png')) === false
    );
    // Symlink creation can be privilege-gated on Windows; skip only those cases there.
    let symlinkOk = true;
    try {
      fs.symlinkSync(outside, path.join(root, 'docs', 'evil'), 'dir');
    } catch {
      symlinkOk = false;
      console.log('  (skip) fs-guard symlink cases: symlink creation not permitted on this host');
    }
    if (symlinkOk) {
      check(
        'fs-guard: symlinked leaf dir below the root is detected',
        pathSegmentsContainSymlink(root, path.join(root, 'docs', 'evil')) === true
      );
      check(
        'fs-guard: symlink mid-path below the root is detected',
        pathSegmentsContainSymlink(root, path.join(root, 'docs', 'evil', 'assets')) === true
      );
      // Review finding (High): on a case-insensitive filesystem the caller's
      // lexical check accepts a case-divergent prefix, so the walk must too —
      // `path.relative` would have answered `../..` here and abstained, letting
      // the write follow the symlink out of the workspace unchecked.
      const caseVaried = path.join(root.toUpperCase(), 'docs', 'evil');
      check(
        'fs-guard: case-divergent prefix is still walked when the caller folds case',
        pathSegmentsContainSymlink(root, caseVaried, true) === true
      );
      check(
        'fs-guard: the same pair abstains on a case-sensitive filesystem',
        pathSegmentsContainSymlink(root, caseVaried, false) === false
      );
      // S-1 residual: the escape is a FILE symlink at the leaf, not a directory
      // one — `assets/report.pdf` → outside file, overwritten by a dropped file
      // carrying that original name. The dangling variant is the worse case:
      // uniqueAssetUri's `stat` throws on it and reads the name as free.
      // Production measures the leaf against the already-guarded ASSETS DIR
      // (dir as root ⇒ exactly one segment below it), so mirror that here.
      const outsideFile = path.join(outside, 'secret.txt');
      fs.writeFileSync(outsideFile, 'x');
      fs.symlinkSync(outsideFile, path.join(assetsDir, 'report.pdf'), 'file');
      fs.symlinkSync(path.join(outside, 'never-created.txt'), path.join(assetsDir, 'dangling.pdf'), 'file');
      check(
        'fs-guard: file-symlink leaf under the assets dir is detected',
        pathSegmentsContainSymlink(assetsDir, path.join(assetsDir, 'report.pdf')) === true
      );
      check(
        'fs-guard: DANGLING file-symlink leaf is detected (lstat does not follow)',
        pathSegmentsContainSymlink(assetsDir, path.join(assetsDir, 'dangling.pdf')) === true
      );
      // Review finding (High): `assets -> ../shared-assets` resolving back
      // inside the workspace is a legitimate layout the caller's realpath
      // fallback accepts. Measuring a not-yet-written leaf from the DIR keeps
      // it allowed; measuring the same leaf from the workspace root refuses it
      // (realpath cannot rescue a file that does not exist yet), which would
      // have broken every paste/drop into such a folder.
      fs.mkdirSync(path.join(root, 'shared-assets'));
      const linkedDir = path.join(root, 'docs', 'linked-assets');
      fs.symlinkSync(path.join(root, 'shared-assets'), linkedDir, 'dir');
      check(
        'fs-guard: a fresh leaf inside a symlinked assets dir stays allowed',
        pathSegmentsContainSymlink(linkedDir, path.join(linkedDir, 'fresh.png')) === false
      );
      check(
        'fs-guard: the same leaf measured from the workspace root is refused (why the caller measures from the dir)',
        pathSegmentsContainSymlink(root, path.join(linkedDir, 'fresh.png')) === true
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

// Req 24 US-23.18 AC6: the undo ledger's state machine is proven directly further down,
// but that proves nothing unless the handler actually CONSULTS it — and the handler is
// unreachable from every test track (no public API opens a custom editor's webview to
// post a message to it). So lock the wiring the same way as the guards above: the refusal
// must appear BEFORE the unscoped `executeCommand(msg.type)`, because after it the global
// command has already run and, with nothing on this document's stack, has already reverted
// whatever WAS on the workspace stack — measured on 2026-07-28 to be the user's last file
// rename. Removing the guard, or sliding it below the command, turns this red.
const undoCaseBody = providerSrc.match(/case 'undo':[\s\S]*?executeCommand\(msg\.type\)/)?.[0] ?? '';
check('AC6: the undo/redo case is found in provider source', undoCaseBody !== '');
check(
  'AC6: a webview undo/redo consults the ledger before issuing the global command',
  /if \(!this\.mayForwardUndo\(document, msg\.type\)\) \{\s*break;/.test(undoCaseBody)
);
check(
  'AC6: the ledger is fed from a provider-level change subscription, not per panel',
  /provider\.recordUndoLedger\(e\.document, undoLedgerReasonOf\(e\.reason\)\)/.test(providerSrc)
);
check(
  'AC6: only real content changes raise the depth',
  /if \(e\.contentChanges\.length > 0\) \{\s*provider\.recordUndoLedger/.test(providerSrc)
);
check(
  'AC6: closing a document forgets its undo history',
  /onDidCloseTextDocument\([\s\S]{0,200}?forgetUndoLedger/.test(providerSrc)
);

// headingSiblingGaps (bug_General #2 follow-up): same-level/same-parent heading move scope.
// Pure outline math on level arrays (null = non-heading block) — mirrors the I/O matrix cases.
{
  // #H1 / ##A + content / ##B  →  A(idx1) siblings = {A@1, B@3}; scope end = doc end.
  const g = headingSiblingGaps([1, 2, null, 2], 1);
  check('sibling: H2 siblings under one H1', JSON.stringify(g.siblingStarts) === '[1,3]', JSON.stringify(g));
  check('sibling: scope end = doc end (no closing heading)', g.scopeEndGap === 4);
  check('sibling: first sibling has no Move Up', g.moveUpGap === null);
  check('sibling: Move Down past next sibling → scope end', g.moveDownGap === 4);
}
{
  // Move the second sibling B up over A: [#H1, ##A, ##B] moving B(idx2).
  const g = headingSiblingGaps([1, 2, 2], 2);
  check('sibling: last sibling Move Up = previous sibling start', g.moveUpGap === 1);
  check('sibling: last sibling has no Move Down', g.moveDownGap === null);
}
{
  // Only child: #H1 / ##A  → A(idx1) has no sibling to swap with (immovable within scope).
  const g = headingSiblingGaps([1, 2], 1);
  check('sibling: only child has just itself', JSON.stringify(g.siblingStarts) === '[1]');
  check('sibling: only child cannot Move Up/Down', g.moveUpGap === null && g.moveDownGap === null);
}
{
  // Top-level H1s (parent = root): #A / #B / #C → all reorder among each other, scope = whole doc.
  const g = headingSiblingGaps([1, 1, 1], 1);
  check('sibling: top-level H1s are all siblings', JSON.stringify(g.siblingStarts) === '[0,1,2]');
  check('sibling: top-level scope = whole doc', g.scopeEndGap === 3);
  check('sibling: middle H1 Move Up=0, Move Down=3', g.moveUpGap === 0 && g.moveDownGap === 3);
}
{
  // Different parents: #H1a / ##x / #H1b / ##y  → ##x(idx1) parent = H1a; ##y is NOT its sibling.
  const g = headingSiblingGaps([1, 2, 1, 2], 1);
  check('sibling: different-parent H2 excluded (scope ends at next H1)', JSON.stringify(g.siblingStarts) === '[1]' && g.scopeEndGap === 2, JSON.stringify(g));
}
{
  // Nested levels: #H1 / ##A / ###a1 / ##B  → A(idx1) siblings under H1 = {A@1, B@3}; a1 is A's child.
  const g = headingSiblingGaps([1, 2, 3, 2], 1);
  check('sibling: nested child (###) is not a sibling of its parent (##)', JSON.stringify(g.siblingStarts) === '[1,3]', JSON.stringify(g));
  check('sibling: A Move Down past its own [A, a1] section → scope end', g.moveDownGap === 4);
}

{
  // Malformed outline: #H1 / ###X / ##Y  → X(idx1, H3) has NO same-level sibling. Its scope must
  // END at the following H2 (level 2 < 3), so it can't be dragged below the H2 and nest under it.
  const g = headingSiblingGaps([1, 3, 2], 1);
  check('sibling: H3 scope stops at a following shallower H2 (no nest-under)', g.scopeEndGap === 2, JSON.stringify(g));
  check('sibling: lone H3 among different levels is immovable', JSON.stringify(g.siblingStarts) === '[1]' && g.moveUpGap === null && g.moveDownGap === null);
}
{
  // Skipped-level, two siblings: #H1 / ###A / ###B / ##C  → A,B are H3 siblings under H1; the
  // trailing H2 (level 2 < 3) must bound the scope so Move Down keeps them BEFORE the H2, never
  // nesting into it (blind review F1 repro B).
  const g = headingSiblingGaps([1, 3, 3, 2], 1);
  check('sibling: skipped-level scope ends at trailing shallower heading', g.scopeEndGap === 3, JSON.stringify(g));
  check('sibling: first of two H3 siblings Move Down stays before the H2', g.moveDownGap === 3);
}
{
  // Doc starting shallower-then-deeper reversed: ##A / #B  → A(idx0, H2) at root has no sibling and
  // must not be draggable below the H1 (would nest under it). scope ends at the H1 (level 1 < 2).
  const g = headingSiblingGaps([2, 1], 0);
  check('sibling: top H2 before an H1 is immovable (scope ends at the H1)', g.scopeEndGap === 1 && JSON.stringify(g.siblingStarts) === '[0]' && g.moveDownGap === null, JSON.stringify(g));
}

// ---------------------------------------------------------------------------
// EntityIndex (Req 21 US-21.2) — host-side workspace entity index. Pure module
// (no 'vscode' import) so it bundles into this node harness like text-utils.
// ---------------------------------------------------------------------------

// caption:: parse — namespace = leading letters, id = remainder.
{
  const rows: IndexedEntity[] = parseEntities('file:///a.md', '## Login flow\n\ncaption::UC01\n');
  eq('entity: caption parses namespace/id/title', rows, [
    { namespace: 'UC', id: '01', file: 'file:///a.md', line: 2, title: 'Login flow', preview: '', label: '' },
  ]);
}

// entityFollowingPreview (Req 21 hover tooltip) — shared truncation rule.
{
  eq('preview: short following text passes through trimmed', entityFollowingPreview(' Submit Leave Request'), 'Submit Leave Request');
  eq('preview: empty when nothing follows', entityFollowingPreview(''), '');
  eq('preview: whitespace-only follows -> empty', entityFollowingPreview('   '), '');
  eq('preview: over 20 chars is capped with an ellipsis', entityFollowingPreview(' A very long description here'), 'A very long descript…');
  eq('preview: stops at a colon (no ellipsis on a delimiter cut)', entityFollowingPreview(' Login: then more'), 'Login');
  eq('preview: stops at a semicolon', entityFollowingPreview(' Login; then more'), 'Login');
  eq('preview: stops at a backtick (inline code / command)', entityFollowingPreview(' run `cmd` now'), 'run');
  eq('preview: stops at a newline', entityFollowingPreview(' first line\nsecond'), 'first line');
  // Code-point-safe cap: an emoji straddling the 20th unit is not split into a broken half.
  eq('preview: caps on code points, not UTF-16 units', entityFollowingPreview('1234567890123456789😀X'), '1234567890123456789😀…');
}

// entityFollowingLabel (Req 21 mention display) — same delimiter rule as the
// preview but UNCAPPED (the entity's full human name), so a long label is kept.
{
  eq('label: passes the full following text through trimmed', entityFollowingLabel(' Submit Leave Request'), 'Submit Leave Request');
  eq('label: NOT capped at 20 chars (unlike the preview)', entityFollowingLabel(' A very long description here'), 'A very long description here');
  eq('label: empty when nothing follows', entityFollowingLabel('   '), '');
  eq('label: stops at the same break delimiters', entityFollowingLabel(' Login: then more'), 'Login');
}

// parseEntities preview alignment: inline code BEFORE the caption must not shift
// the following-text slice (stripInlineCode is length-preserving).
{
  const rows = parseEntities('file:///pv2.md', 'See `foo()` caption::UC01 The login flow\n');
  eq('entity: preview correct when inline code precedes the caption', rows.map((r) => `${r.namespace}${r.id}=${r.preview}`), ['UC01=The login flow']);
}

// parseEntities carries the following-text preview per declaration.
{
  const rows = parseEntities('file:///pv.md', 'caption::UC01 Submit Leave Request\ncaption::BR05\n');
  eq('entity: preview = text following the token', rows.map((r) => r.preview), ['Submit Leave Request', '']);
  eq('entity: label = full following text (uncapped) per declaration', rows.map((r) => r.label), ['Submit Leave Request', '']);
}

// id match (both full id and partial) + title match — proves id-OR-title query.
{
  const idx = new EntityIndex();
  idx.build([{ uri: 'file:///a.md', text: '## Login flow\n\ncaption::UC01\n' }]);
  check('entity: query by full id UC01', idx.query('UC01').length === 1);
  check('entity: query by partial id 01', idx.query('01').length === 1);
  check('entity: query by title token "login"', idx.query('login').length === 1);
  check('entity: query by full title "Login flow"', idx.query('Login flow').length === 1);
  check('entity: non-matching query returns nothing', idx.query('zzz').length === 0);
  const q = idx.query('UC01')[0];
  check('entity: namespace parsed as UC, id 01', q.namespace === 'UC' && q.id === '01');
}

// Bug C1 — a short token must not match mid-word inside a title. Typing `UC`
// used to return `BR05`/`NAMESPACE_ID` because their titles contain "strUCtured".
{
  const idx = new EntityIndex();
  idx.build([
    { uri: 'file:///a.md', text: '# Login flow\ncaption::UC01\n' },
    { uri: 'file:///b.md', text: '# Structured Entity Reference System\ncaption::BR05\n' },
    { uri: 'file:///c.md', text: '# 21 Structured Entity Reference\ncaption::NAMESPACE_ID\n' },
  ]);
  const uc = idx.query('UC');
  check('entity: query "UC" excludes mid-word title hits (BR05/NAMESPACE_ID)', uc.length === 1 && uc[0].namespace === 'UC');
  check('entity: title word-start search still matches ("structured")', idx.query('structured').length === 2);
}

// Empty/malformed declarations are refused (US-21.1 empty-id).
{
  const rows = parseEntities('file:///m.md', 'caption::\ncaption::UC02\ncaption::123\n');
  eq('entity: empty id + no-namespace declarations skipped', rows.map((r) => r.namespace + r.id), ['UC02']);
}

// Trailing punctuation the `\S+` capture absorbed from prose/markdown is stripped.
{
  const rows = parseEntities('file:///p.md', 'caption::UC01`,\ncaption::BR05).\ncaption::UC02\n');
  eq('entity: trailing punctuation stripped from parsed token', rows.map((r) => r.namespace + r.id), ['UC01', 'BR05', 'UC02']);
}

// nearestEnclosingHeading — nesting, fence-immunity, above-any-heading.
{
  const lines = '# Top\n\n## Mid\n\ncaption::UC01\n\n### Deep\ncaption::UC02\n'.split('\n');
  eq('entity: nearest heading picks the immediately-enclosing ## Mid', nearestEnclosingHeading(lines, 4), 'Mid');
  eq('entity: nearest heading updates to ### Deep further down', nearestEnclosingHeading(lines, 7), 'Deep');
}
{
  const lines = '# Real\n\n```\n# NotAHeading\n```\ncaption::UC01\n'.split('\n');
  eq('entity: a "#"-looking line inside a fence is not a heading', nearestEnclosingHeading(lines, 5), 'Real');
}
{
  const lines = 'caption::UC01\n\n# Later\n'.split('\n');
  eq('entity: caption above any heading -> empty title', nearestEnclosingHeading(lines, 0), '');
}

// caption inside a fence is not indexed.
{
  const rows = parseEntities('file:///f.md', '# H\n\n```\ncaption::UC99\n```\ncaption::UC01\n');
  eq('entity: caption inside a fence is skipped', rows.map((r) => r.id), ['01']);
}

// Bug D2 — a caption:: written inside an inline code span (backticks) is
// documentation/example syntax, not a live declaration, so it is NOT indexed
// (matches the webview's CODE-ancestor skip; PO 2026-07-22). Reproduces the
// Requirement 21 file's `declare inline (`caption::UC01`)` examples.
{
  const rows = parseEntities('file:///d2.md', 'declare a named entity inline (`caption::UC01`) here\n');
  eq('entity D2: caption inside inline code span is not indexed', rows.map((r) => r.namespace + r.id), []);
}
{
  const rows = parseEntities('file:///d2.md', 'code `caption::UC01` but plain caption::RE02 counts\n');
  eq('entity D2: only the plain caption on a mixed line is indexed', rows.map((r) => r.namespace + r.id), ['RE02']);
}
{
  const rows = parseEntities('file:///d2.md', 'caption::UC01\n');
  eq('entity D2: a plain (non-backticked) declaration is still indexed', rows.map((r) => r.namespace + r.id), ['UC01']);
}
{
  // A lone backtick that never closes is not a code span — the token survives.
  const rows = parseEntities('file:///d2.md', 'caption::UC01`, and more\n');
  eq('entity D2: unmatched backtick is literal, token still indexed', rows.map((r) => r.namespace + r.id), ['UC01']);
}

// Incremental update — onFileChanged replaces just that file's rows.
{
  const idx = new EntityIndex();
  idx.build([{ uri: 'file:///a.md', text: '# H\ncaption::UC01\n' }]);
  check('entity: initial row present', idx.query('UC01').length === 1);
  idx.onFileChanged('file:///a.md', '# H\ncaption::UC02\n');
  check('entity: old row gone after incremental update', idx.query('UC01').length === 0);
  check('entity: new row present after incremental update', idx.query('UC02').length === 1);
  idx.onFileChanged('file:///a.md', ''); // deleted / emptied file drops its rows.
  check('entity: emptied file drops all its rows', idx.query('UC02').length === 0);
}

// P2 — search haystacks are rebuilt on incremental update: a diacritic-stripped
// query must match a Vietnamese-diacritic title introduced via onFileChanged.
{
  const idx = new EntityIndex();
  idx.build([{ uri: 'file:///a.md', text: '# H\ncaption::UC01\n' }]);
  idx.onFileChanged('file:///a.md', '# UC-02 Đăng nhập hệ thống\ncaption::UC-02 Đăng nhập hệ thống\n');
  const hits = idx.query('dang-nhap');
  check('entity P2: diacritic-stripped query matches title after incremental re-parse', hits.length === 1 && hits[0].id === '-02');
}

// Indexing state — isReady() false before build, true after.
{
  const idx = new EntityIndex();
  check('entity: fresh index is not ready (indexing state)', idx.isReady() === false);
  idx.build([]);
  check('entity: index is ready after build', idx.isReady() === true);
}

// namespaces() — count-desc sort + case-insensitive fold to first-seen casing.
{
  const idx = new EntityIndex();
  idx.build([
    { uri: 'file:///a.md', text: 'caption::UC01\ncaption::UC02\ncaption::BR01\n' },
    { uri: 'file:///b.md', text: 'caption::uc03\n' }, // case variant of UC.
  ]);
  const ns = idx.namespaces();
  eq('entity: namespaces fold case-insensitively, sort by count desc', ns, [
    { name: 'UC', count: 3 },
    { name: 'BR', count: 1 },
  ]);
}

// namespace filter narrows case-insensitively.
{
  const idx = new EntityIndex();
  idx.build([{ uri: 'file:///a.md', text: 'caption::UC01\ncaption::BR01\n' }]);
  check('entity: namespace filter narrows (case-insensitive)', idx.query('', { namespace: 'uc' }).length === 1);
  check('entity: empty query returns all when no namespace filter', idx.query('').length === 2);
}

// lookup() — EXACT id resolver for broken-reference existence (Req 21 US-21.3).
{
  const idx = new EntityIndex();
  idx.build([{ uri: 'file:///a.md', text: 'caption::UC01\ncaption::BR02\n' }]);
  check('entity: lookup exact id hits', idx.lookup('UC01').length === 1);
  check('entity: lookup namespace is case-insensitive', idx.lookup('uc01').length === 1);
  check('entity: lookup id is case-sensitive / exact (no fuzzy)', idx.lookup('UC0').length === 0);
  check('entity: lookup empty id half returns none', idx.lookup('UC').length === 0);
  check('entity: lookup unknown id returns none', idx.lookup('XX99').length === 0);
}

// canonicalEntityId — ns folded to lower, id kept; invalid tokens rejected.
{
  eq('occurrence: canonical folds ns to lower', canonicalEntityId('UC01'), 'uc01');
  check('occurrence: canonical rejects all-letters (empty id)', canonicalEntityId('readme') === null);
  check('occurrence: canonical rejects no-letter-prefix', canonicalEntityId('01') === null);
}

// scanEntityOccurrences — reference links only, fence-aware, canonical ids.
{
  const occ = scanEntityOccurrences('See [UC01](#UC01) and [again](other.md#uc01).\n\n[x](https://a.com)\n');
  eq('occurrence: entity-ref links found (canonical), non-entity links skipped', occ, [
    { id: 'uc01', line: 0 },
    { id: 'uc01', line: 0 },
  ]);
  const fenced = scanEntityOccurrences('```\n[UC01](#UC01)\n```\n[BR02](#BR02)\n');
  eq('occurrence: links inside a fence are skipped', fenced, [{ id: 'br02', line: 3 }]);
}

// X-5: a non-ASCII namespace can reach the host percent-encoded (markdown-it /
// turndown persist it that way) and in either Unicode form — the host must
// decode+NFC before NAMESPACE_RE, on both the occurrence and the lookup paths.
{
  const canon = 'Yêu01'.normalize('NFC').toLowerCase();
  // canonicalEntityId decodes a percent-encoded fragment before parsing the ns
  // (raw `Y%C3%Aau01` would otherwise let NAMESPACE_RE match only the leading `Y`).
  eq('occurrence x5: canonical decodes percent-encoded non-ASCII ns', canonicalEntityId('Y%C3%Aau01'), canon);
  // Scan-key (from raw .md) and query key (from the webview id) both go through
  // canonicalEntityId, so a percent-encoded link is found under the same key.
  eq('occurrence x5: percent-encoded non-ASCII link found', scanEntityOccurrences('See [Yêu01](#Y%C3%Aau01) here.\n'), [
    { id: canon, line: 0 },
  ]);

  const idx = new EntityIndex();
  idx.build([{ uri: 'file:///a.md', text: 'caption::Yêu01\n' }]);
  check('entity x5: lookup resolves a percent-encoded non-ASCII query', idx.lookup('Y%C3%Aau01').length === 1);
  // An NFD-form mention query resolves against the NFC-authored declaration
  // (decodeEntityFragment folds the query to NFC).
  check('entity x5: lookup resolves an NFD query against an NFC declaration', idx.lookup('Yêu01'.normalize('NFD')).length === 1);

  // X-5 (deferred follow-up): an NFD-authored DECLARATION now parses correctly —
  // parseEntities NFCs the token before NAMESPACE_RE, so `caption::Yêu01` written
  // in NFD recomposes to namespace `Yêu`, id `01` instead of splitting at the
  // combining mark (namespace `Ye`). Both NFC and NFD queries then resolve it.
  {
    const nfdDecl = new EntityIndex();
    nfdDecl.build([{ uri: 'file:///nfd.md', text: `caption::${'Yêu01'.normalize('NFD')}\n` }]);
    const rows = nfdDecl.lookup('Yêu01');
    check('entity x5: NFD declaration parses namespace whole (NFC query resolves)', rows.length === 1);
    check('entity x5: NFD declaration namespace recomposed to "Yêu"', rows[0]?.namespace === 'Yêu' && rows[0]?.id === '01');
    check('entity x5: NFD declaration resolves an NFD query too', nfdDecl.lookup('Yêu01'.normalize('NFD')).length === 1);
  }
  // A parseEntities-level check on the stored row shape (namespace not split at
  // the combining mark).
  {
    const rows = parseEntities('file:///nfd2.md', `caption::${'Đăng01'.normalize('NFD')} label\n`);
    eq('entity x5: NFD declaration stored namespace is NFC-whole', rows.map((r) => r.namespace + r.id), ['Đăng01']);
  }
}

// truncateDisplay — Bug 11: cap @ result label/detail at 30 chars + ellipsis.
{
  check('truncate: short text unchanged', truncateDisplay('BR02') === 'BR02');
  check('truncate: exactly 20 chars unchanged', truncateDisplay('a'.repeat(20)) === 'a'.repeat(20));
  eq('truncate: >30 chars → 30 chars + ellipsis', truncateDisplay('Requirement: 21. Structured Entity Reference System'), 'Requirement: 21. Structured En…');
  check('truncate: result length is 30 + ellipsis', truncateDisplay('b'.repeat(50)) === 'b'.repeat(30) + '…');
  check('truncate: empty string unchanged', truncateDisplay('') === '');
  check('truncate: does not split a surrogate pair at the boundary', truncateDisplay('😀'.repeat(40)) === '😀'.repeat(30) + '…');
}

// ---------------------------------------------------------------------------
// Bug #3 — echo-suppression cho applyEditBreakingCoalesce. provider.ts import
// 'vscode' nên không nạp được ở đây; MÔ PHỎNG đúng quyết định echo của
// changeSubscription + case 'edit' (giống model applyEdit ở đầu file). Nhánh
// nghịch đảo áp HAI applyEdit → hai sự kiện đổi; sự kiện TRUNG GIAN mới là thứ
// rò filter-text nếu không có guard breakingEditInProgress.
// ---------------------------------------------------------------------------
{
  // Bám sát applyEditBreakingCoalesce (src/provider.ts): phát sự kiện đổi cho
  // trạng thái GIỮA rồi trạng thái CUỐI, đúng cấu trúc nhánh của hàm thật.
  function emitBreakingChanges(before: string, after: string, onChange: (t: string) => void): void {
    const diff = computeMinimalEdit(before, after);
    if (!diff) {
      return;
    }
    const { start, oldEnd, newText: ins } = diff;
    if (ins === '' && oldEnd - start >= 2) {
      const mid = start + Math.floor((oldEnd - start) / 2);
      onChange(before.slice(0, mid) + before.slice(oldEnd)); // xoá nửa sau (giữa)
      onChange(after); // xoá nửa đầu (cuối)
      return;
    }
    if (ins !== '' && oldEnd > start) {
      onChange(before.slice(0, start) + before.slice(oldEnd)); // đã xoá, chưa chèn (giữa)
      onChange(after);
      return;
    }
    onChange(after); // chèn thuần / xoá 1 ký tự: một sự kiện
  }

  function makeHost(withGuard: boolean) {
    let lastTextFromWebview: string | undefined;
    let prevEditBeforeText: string | undefined;
    let breakingEditInProgress = false;
    let doc = '';
    let updatesPosted = 0;

    // changeSubscription: chỉ phần quyết định echo (bỏ nhánh undo/redo).
    function onChange(newText: string): void {
      doc = newText;
      if (withGuard && breakingEditInProgress) {
        return; // Bug #3 guard
      }
      if (newText === lastTextFromWebview) {
        return; // echo của chính webview (khớp text cuối)
      }
      lastTextFromWebview = undefined;
      updatesPosted++; // lên lịch 'update' debounce → echo về webview
    }

    // case 'edit'.
    function edit(text: string): void {
      const beforeThis = doc;
      const isInverseOfPrev =
        prevEditBeforeText !== undefined && text === prevEditBeforeText && text !== beforeThis;
      lastTextFromWebview = text;
      if (isInverseOfPrev) {
        breakingEditInProgress = true;
        try {
          emitBreakingChanges(beforeThis, text, onChange);
        } finally {
          breakingEditInProgress = false;
        }
      } else {
        onChange(text); // applyMinimalEdit: một sự kiện
      }
      prevEditBeforeText = beforeThis;
    }

    return { edit, external: onChange, get updates() { return updatesPosted; } };
  }

  // Kịch bản rò (Bug #3): sau "foo" gõ "/De" rồi commit trigger xoá "/De" về
  // "foo". prevEditBeforeText là doc-state TRƯỚC edit liền trước, nên phải seed
  // "foo" bằng một edit rồi mới gõ "/De" — khi đó commit về "foo" mới là nghịch
  // đảo chính xác của edit trước → chạy nhánh breaking (HAI applyEdit).
  function runScenario(withGuard: boolean): number {
    const h = makeHost(withGuard);
    h.edit('foo'); // seed
    h.edit('foo/De'); // gõ trigger + filter (edit thường)
    h.edit('foo'); // commit delete-only (inverse-of-prev → breaking)
    return h.updates;
  }
  check('bug3: commit nghịch đảo KHÔNG post update khi có guard', runScenario(true) === 0);
  // Reproduce-first: bỏ guard → ít nhất một 'update' thừa bị lên lịch (sự kiện
  // trung gian ≠ text cuối vượt echo-check rồi clear lastTextFromWebview). Số
  // đếm chính xác tuỳ debounce gộp — bất biến then chốt là >0 so với 0 khi có guard.
  check('bug3: KHÔNG guard → có update thừa bị lên lịch (reproduce)', runScenario(false) > 0);

  // Edit ngoài thật (git/format...) vẫn phải post update.
  const ext = makeHost(true);
  ext.external('bar'); // thay đổi không do webview
  check('bug3: edit ngoài thật vẫn post update (không over-suppress)', ext.updates === 1);
}

// --- Req 23 US-23.1: comment author + createComment payload validation --------
{
  const msg = (over: Partial<CreateCommentMessage> = {}): CreateCommentMessage => ({
    type: 'createComment',
    requestId: 1,
    docUri: 'file:///a.md',
    threadId: 'thread-1',
    anchorId: 'comment-anchor-1',
    offsetStart: 0,
    offsetEnd: 5,
    line: 3,
    body: 'Why this wording?',
    recordedText: 'AC-2 — The held queue drains in enqueue order.',
    nearestHeading: 'Acceptance criteria',
    ...over,
  });

  check('comment author: setting wins over the OS username', resolveCommentAuthor('reviewer', 'osuser') === 'reviewer');
  check('comment author: unset setting falls back to the OS username', resolveCommentAuthor(undefined, 'osuser') === 'osuser');
  check('comment author: whitespace-only setting is treated as unset', resolveCommentAuthor('   ', 'osuser') === 'osuser');

  check('createComment: a well-formed request is accepted', createCommentRejection(msg(), 'file:///a.md') === null);
  check(
    'createComment: a message for another document is refused (tab switch)',
    createCommentRejection(msg(), 'file:///b.md') !== null
  );
  check('createComment: an empty body never creates a thread', createCommentRejection(msg({ body: '' }), 'file:///a.md') !== null);
  check(
    'createComment: a whitespace-only body never creates a thread',
    createCommentRejection(msg({ body: ' \n\t ' }), 'file:///a.md') !== null
  );
  check('createComment: a missing anchor id is refused', createCommentRejection(msg({ anchorId: '' }), 'file:///a.md') !== null);
  check(
    'createComment: a reversed offset pair is refused',
    createCommentRejection(msg({ offsetStart: 9, offsetEnd: 2 }), 'file:///a.md') !== null
  );
  check(
    'createComment: a negative offset is refused',
    createCommentRejection(msg({ offsetStart: -1 }), 'file:///a.md') !== null
  );
  check('createComment: a thread with no id is refused (it could never be addressed again)',
    createCommentRejection(msg({ threadId: '' }), 'file:///a.md') !== null);
  check('createComment: a collapsed caret anchor is accepted', createCommentRejection(msg({ offsetStart: 4, offsetEnd: 4 }), 'file:///a.md') === null);

  // 1-based webview line -> 0-based vscode.Range line; 0 means "maps to no source line".
  check('comment thread line: 1-based source line becomes 0-based', commentThreadLine(3) === 2);
  check('comment thread line: an unmapped anchor lands on line 0', commentThreadLine(0) === 0);
}

// --- Req 23 US-23.10 AC4: author-prompt name validation ----------------------
{
  check('author prompt: a plain name is accepted', authorNamePromptRejection('Alice') === null);
  check('author prompt: leading/trailing whitespace is trimmed before validating',
    authorNamePromptRejection('  Alice  ') === null);
  check('author prompt: empty-after-trim is rejected', authorNamePromptRejection('   ') !== null);
  check('author prompt: empty string is rejected', authorNamePromptRejection('') !== null);
  check('author prompt: NFD and NFC forms both validate the same way',
    (authorNamePromptRejection('Nhật'.normalize('NFD')) === null) === (authorNamePromptRejection('Nhật'.normalize('NFC')) === null));
  check('author prompt: a newline is rejected', authorNamePromptRejection('Alice\nBob') !== null);
  check('author prompt: a control character (NUL) is rejected', authorNamePromptRejection(`Alice${String.fromCharCode(0)}`) !== null);
  check('author prompt: exactly 100 characters is accepted', authorNamePromptRejection('a'.repeat(100)) === null);
  check('author prompt: 101 characters is rejected', authorNamePromptRejection('a'.repeat(101)) !== null);
}

// --- Req 23 US-23.10 AC7: sidecar refusalFor's three-reason completeness ----
// sidecar-store.ts imports 'vscode' so it cannot be loaded here — MODELED
// against its own `outsideRootRejection` (untitled -> non-file scheme ->
// outside-allowed-root via the injected guard), same convention as the Bug #3
// echo-suppression model above.
{
  interface FakeDoc {
    isUntitled: boolean;
    scheme: string;
  }
  // Synchronous model: the real `outsideRootRejection` awaits the injected
  // `guard`, but nothing here depends on that being genuinely asynchronous —
  // `insideAllowedRoots` stands in for its already-resolved answer.
  function modelRefusalFor(doc: FakeDoc, insideAllowedRoots: boolean): string | null {
    if (doc.isUntitled) {
      return 'Save the file first to comment on it.';
    }
    if (doc.scheme !== 'file') {
      return 'Comments need a file on disk; this document is on a virtual filesystem.';
    }
    if (!insideAllowedRoots) {
      return 'The comment sidecar would be written outside the allowed workspace.';
    }
    return null;
  }

  const saved = { isUntitled: false, scheme: 'file' };
  check('refusalFor: untitled is refused', modelRefusalFor({ isUntitled: true, scheme: 'file' }, true) !== null);
  check('refusalFor: a non-file scheme is refused', modelRefusalFor({ isUntitled: false, scheme: 'untitled' }, true) !== null);
  check('refusalFor: outside the allowed workspace roots is refused (US-23.10 AC7 — the third, previously-missing case)',
    modelRefusalFor(saved, false) !== null);
  check('refusalFor: a saved, file-scheme, in-root document is accepted', modelRefusalFor(saved, true) === null);
  // The three reasons must be distinct — a caller wiring the specific reason
  // into the UI (AC7) needs to tell them apart, not just "refused".
  const untitled = modelRefusalFor({ isUntitled: true, scheme: 'file' }, true);
  const nonFile = modelRefusalFor({ isUntitled: false, scheme: 'untitled' }, true);
  const outsideRoot = modelRefusalFor(saved, false);
  check('refusalFor: the three reasons are pairwise distinct',
    untitled !== nonFile && nonFile !== outsideRoot && untitled !== outsideRoot);
}

// --- Req 23 US-23.20 AC2/AC8: unconditional-newline append, backup naming ---
// sidecar-store.ts imports 'vscode' so `append`/`planRename` aren't reachable
// here — but the AC8 helper (`sidecarBackupNameFor`) lives in sidecar-format.ts
// with no vscode import, so it's real-unit-tested, not modeled. AC2's payload
// composition is now trivial (no more endsWithNewline branch to model either).
{
  const anchor = {
    offset_start: 0,
    offset_end: 5,
    recorded_text: 'AC-2 — the newline',
    last_known_line: 1,
    nearest_heading: '',
  };
  const line = buildCommentLine({
    id: 'c1',
    author: 'reviewer',
    timestamp: '2026-07-27T21:11:40.000Z',
    body: 'why?',
    anchor,
  });
  const payload = '\n' + serializeSidecarLine(line);
  check('append payload (AC2): always starts with a newline, regardless of any prior tail state',
    payload.startsWith('\n'));
  check('append payload (AC2): still ends with the line’s own terminating newline from serializeSidecarLine',
    payload.endsWith('\n') && payload.slice(1, -1) === JSON.stringify(line));

  check('sidecarBackupNameFor: appends the stamp and .bak suffix beside the sidecar name',
    sidecarBackupNameFor('foo.md.orca-comments.jsonl', '2026-07-27T21-11-40-000Z')
      === 'foo.md.orca-comments.jsonl.2026-07-27T21-11-40-000Z.bak');
  check('sidecarBackupNameFor: the stamp is carried through unchanged (caller derives a filesystem-safe one)',
    sidecarBackupNameFor('x', '2026-07-27T21-11-40-000Z').includes('2026-07-27T21-11-40-000Z'));
  check('sidecarBackupNameFor: always ends with .bak',
    sidecarBackupNameFor('foo.md.orca-comments.jsonl', 'stamp').endsWith('.bak'));
}

// --- Req 24 US-23.19: save-first gate — refusalFor -> isDirty -> save() -----
// commentController.ts's real `saveBeforeAppend` imports 'vscode' so it isn't
// reachable here — MODELED as a synchronous shadow of its control flow, same
// convention as `modelRefusalFor` above (nothing here depends on genuine
// asynchrony; `saveSucceeds`/`insideAllowedRoots` stand in for already-resolved
// answers). `log` records which steps actually ran, so a test can assert what
// did NOT happen (no save on a clean document, no save on a refused document).
{
  interface FakeDirtyDoc {
    isUntitled: boolean;
    scheme: string;
    isDirty: boolean;
  }

  function modelSaveBeforeAppend(
    doc: FakeDirtyDoc,
    insideAllowedRoots: boolean,
    saveSucceeds: boolean,
    log: string[]
  ): string | null {
    log.push('refusalFor');
    if (doc.isUntitled) {
      return 'Save the file first to comment on it.';
    }
    if (doc.scheme !== 'file') {
      return 'Comments need a file on disk; this document is on a virtual filesystem.';
    }
    if (!insideAllowedRoots) {
      return 'The comment sidecar would be written outside the allowed workspace.';
    }
    if (doc.isDirty) {
      log.push('save');
      if (!saveSucceeds) {
        return 'Could not save the file before recording the comment.';
      }
    }
    return null;
  }

  const clean = { isUntitled: false, scheme: 'file', isDirty: false };
  const dirty = { isUntitled: false, scheme: 'file', isDirty: true };

  const cleanLog: string[] = [];
  check('save-first gate (AC3): a clean document never calls save',
    modelSaveBeforeAppend(clean, true, true, cleanLog) === null && !cleanLog.includes('save'));

  const dirtySavedLog: string[] = [];
  check('save-first gate (AC1): a dirty document is saved, in order, before the append would run',
    modelSaveBeforeAppend(dirty, true, true, dirtySavedLog) === null && dirtySavedLog.join(',') === 'refusalFor,save');

  const dirtyFailedLog: string[] = [];
  check('save-first gate (AC2): a failed save is reported and the caller never reaches append',
    modelSaveBeforeAppend(dirty, true, false, dirtyFailedLog) === 'Could not save the file before recording the comment.');

  const untitledLog: string[] = [];
  check('save-first gate (AC5): untitled is refused by the existing refusalFor check before isDirty/save ever run',
    modelSaveBeforeAppend({ isUntitled: true, scheme: 'file', isDirty: true }, true, true, untitledLog)
      === 'Save the file first to comment on it.' && !untitledLog.includes('save'));
}

// --- Req 23 US-23.10 AC9: body neutralization + EOL reconciliation ----------
{
  check('neutralizeBodyText: plain text is unchanged', neutralizeBodyText('Why this wording?') === 'Why this wording?');
  check('neutralizeBodyText: a newline is kept (multi-line body)', neutralizeBodyText('line one\nline two') === 'line one\nline two');
  check('neutralizeBodyText: a tab is kept', neutralizeBodyText('a\tb') === 'a\tb');
  check('neutralizeBodyText: a right-to-left override (RLO) is stripped',
    neutralizeBodyText(`safe${String.fromCharCode(0x202e)}evil`) === 'safeevil');
  check('neutralizeBodyText: every bidi override/isolate control char is stripped',
    neutralizeBodyText([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map((c) => String.fromCharCode(c)).join('x')) === 'xxxxxxxx');
  check('neutralizeBodyText: a NUL byte is stripped', neutralizeBodyText(`a${String.fromCharCode(0)}b`) === 'ab');
  check('neutralizeBodyText: DEL is stripped', neutralizeBodyText(`a${String.fromCharCode(0x7f)}b`) === 'ab');

  check('normalizeBodyEol: CRLF becomes LF', normalizeBodyEol('line one\r\nline two') === 'line one\nline two');
  check('normalizeBodyEol: a lone CR becomes LF', normalizeBodyEol('line one\rline two') === 'line one\nline two');
  check('normalizeBodyEol: LF-only text is unchanged', normalizeBodyEol('line one\nline two') === 'line one\nline two');
}

// --- Req 23 US-23.4: tier-2 anchor matching + anchor-update validation -------
{
  const candidate = (text: string, line: number, heading = '', depth = 1): AnchorCandidate => ({
    text,
    line,
    heading,
    depth,
  });

  check('anchor text: whitespace runs collapse so a re-wrapped paragraph still matches',
    normalizeAnchorText('The held  queue\n  drains') === 'The held queue drains');
  check('anchor text: normalization is NFC', normalizeAnchorText('Nhật'.normalize('NFD')) === 'Nhật'.normalize('NFC'));
  check('levenshtein: identical strings cost nothing', levenshtein('queue', 'queue') === 0);
  check('levenshtein: one substitution costs one', levenshtein('Done', 'Dome') === 1);
  check('similarity: a line-break reflow scores a perfect match',
    similarity('The held queue drains', 'The held\nqueue   drains') === 1);
  check('similarity: NFC and NFD forms of the same prose score a perfect match',
    similarity('Nhật ký'.normalize('NFC'), 'Nhật ký'.normalize('NFD')) === 1);

  check('threshold: ordinary text uses 0.8', anchorThresholdFor('AC-2 — the held queue drains') === 0.8);
  check('threshold: text under 15 chars uses 0.95', anchorThresholdFor('Done') === 0.95);

  const recorded = 'AC-2 — The held queue drains in enqueue order.';
  const hit = pickAnchorCandidate(
    recorded,
    [candidate('AC-1 — Refund requests are held for replay.', 11), candidate('AC-2 — The held queue\ndrains in enqueue order.', 12)],
    { lastKnownLine: 12, nearestHeading: '' }
  );
  check('tier 2: the reflowed original wins', hit?.index === 1 && hit.score === 1);

  check('tier 2: a short recorded text does not settle for a near miss',
    pickAnchorCandidate('Done', [candidate('Dome', 4)], { lastKnownLine: 4, nearestHeading: '' }) === null);
  check('tier 2: a short recorded text still matches itself',
    pickAnchorCandidate('Done', [candidate('Done', 9)], { lastKnownLine: 4, nearestHeading: '' })?.index === 0);
  check('tier 2: nothing above the threshold is a miss, not a best guess',
    pickAnchorCandidate('The held queue drains in enqueue order',
      [candidate('Totally unrelated sentence about refunds', 3)], { lastKnownLine: 3, nearestHeading: '' }) === null);
  check('tier 2: an empty recorded text never matches',
    pickAnchorCandidate('   ', [candidate('anything', 1)], { lastKnownLine: 1, nearestHeading: '' }) === null);

  // Two structurally identical bullets in different sections — the score alone
  // cannot separate them, so the recorded context has to.
  const twins = [candidate('Each entry records a reason code.', 8, 'Refunds'), candidate('Each entry records a reason code.', 40, 'Payouts')];
  check('tier 2 tie-break: the recorded heading picks the right twin',
    pickAnchorCandidate('Each entry records a reason code.', twins, { lastKnownLine: 41, nearestHeading: 'Refunds' })?.index === 0);
  check('tier 2 tie-break: with no heading to go on, the nearest line wins',
    pickAnchorCandidate('Each entry records a reason code.', twins, { lastKnownLine: 39, nearestHeading: '' })?.index === 1);
  check('tier 2 tie-break: still ambiguous means fall through to tier 3, not a guess',
    pickAnchorCandidate('Each entry records a reason code.',
      [candidate('Each entry records a reason code.', 8), candidate('Each entry records a reason code.', 8)],
      { lastKnownLine: 0, nearestHeading: '' }) === null);

  // A blockquote and its only paragraph read identically and report the same
  // line — depth is the only thing left that can separate them.
  const nested = [candidate('Quoted claim.', 3, '', 1), candidate('Quoted claim.', 3, '', 2)];
  check('tier 2 tie-break: the innermost of two identical nested nodes wins',
    pickAnchorCandidate('Quoted claim.', nested, { lastKnownLine: 3, nearestHeading: '' })?.index === 1);
  check('tier 2 tie-break: the heading comparison is normalized, not raw',
    pickAnchorCandidate(
      'Each entry records a reason code.',
      [candidate('Each entry records a reason code.', 8, 'Nhật ký'.normalize('NFD')),
       candidate('Each entry records a reason code.', 40, 'Payouts')],
      { lastKnownLine: 41, nearestHeading: 'Nhật ký'.normalize('NFC') }
    )?.index === 0);
  // A candidate whose length alone puts it out of reach, and does not contain
  // the recorded text at all, is rejected without running the O(n*m) distance.
  check('tier 2: a candidate too different in length AND unrelated in content is skipped',
    pickAnchorCandidate('The held queue drains in enqueue order.',
      [candidate('Something else entirely, padded out with unrelated words. ' + 'x'.repeat(60), 3)],
      { lastKnownLine: 3, nearestHeading: '' }) === null);
  // Req 24 US-23.13 AC4: a merge (Backspace joining two paragraphs) grows a
  // node's text around what was already there — the recorded snapshot still
  // survives verbatim, so this now matches even though the length ratio alone
  // would fail the usual threshold. Revises the pre-US-23.13 expectation above
  // (a same-shaped padded candidate) since that shape is exactly what a merge
  // produces.
  check('tier 2 / US-23.13 AC4: a merged (grown) node still matches when the recorded text survives as a verbatim substring',
    pickAnchorCandidate('The held queue drains in enqueue order.',
      [candidate('The held queue drains in enqueue order. Another paragraph joined onto it.', 3)],
      { lastKnownLine: 3, nearestHeading: '' })?.score === 1);
  // US-23.13 AC4 review finding: the containment shortcut must not bypass the
  // short-text threshold — a short recorded string turning up as a substring
  // of some UNRELATED, longer block elsewhere in the document (not a merge of
  // that block with the comment's own paragraph) must still be rejected, the
  // same as before this AC existed.
  check('tier 2 / US-23.13 AC4: a short recorded text appearing inside an unrelated longer block is still rejected, not containment-matched',
    pickAnchorCandidate('Done.',
      [candidate('Something unrelated. Done. Something else unrelated still.', 9)],
      { lastKnownLine: 9, nearestHeading: '' }) === null);

  const update = (over: Partial<AnchorUpdateMessage> = {}): AnchorUpdateMessage => ({
    type: 'commentAnchorUpdate',
    docUri: 'file:///a.md',
    threadId: 'thread-1',
    anchorId: 'comment-anchor-1',
    line: 12,
    state: 'approximate',
    offsetStart: 0,
    offsetEnd: 0,
    recordedText: '',
    nearestHeading: '',
    ...over,
  });
  check('anchorUpdate: a well-formed update is accepted', anchorUpdateRejection(update(), 'file:///a.md') === null);
  check('anchorUpdate: an update for another document is refused',
    anchorUpdateRejection(update(), 'file:///b.md') !== null);
  check('anchorUpdate: an update naming no thread is refused',
    anchorUpdateRejection(update({ threadId: '' }), 'file:///a.md') !== null);
  // 0 is the "maps to no source line" value createComment already accepts, so
  // refusing it here would leave whole-document anchors unable to relocate.
  check('anchorUpdate: line 0 (an unmapped anchor) is accepted',
    anchorUpdateRejection(update({ line: 0 }), 'file:///a.md') === null);
  check('anchorUpdate: a negative line is refused',
    anchorUpdateRejection(update({ line: -1 }), 'file:///a.md') !== null);
  check('anchorUpdate: an unknown resolution state is refused',
    anchorUpdateRejection(update({ state: 'resolved' as AnchorUpdateMessage['state'] }), 'file:///a.md') !== null);
}

// --- Req 23 US-23.2: reply/delete validation + sidecar line shapes ----------
{
  const reply = (over: Partial<ReplyMessage> = {}): ReplyMessage => ({
    type: 'replyToComment',
    requestId: 1,
    docUri: 'file:///a.md',
    threadId: 'thread-1',
    body: 'Fixed, please re-check.',
    ...over,
  });
  check('reply: a well-formed reply to an Open thread is accepted',
    replyRejection(reply(), 'file:///a.md', 'Open') === null);
  check('reply: a reply to a Resolved thread is still accepted',
    replyRejection(reply(), 'file:///a.md', 'Resolved') === null);
  // AC: "Replying is blocked while the thread is Closed".
  check('reply: a reply to a Closed thread is refused',
    replyRejection(reply(), 'file:///a.md', 'Closed') !== null);
  check('reply: an empty body is refused',
    replyRejection(reply({ body: '' }), 'file:///a.md', 'Open') !== null);
  check('reply: a whitespace-only body is refused',
    replyRejection(reply({ body: '   \n\t ' }), 'file:///a.md', 'Open') !== null);
  check('reply: a reply for another document is refused',
    replyRejection(reply(), 'file:///b.md', 'Open') !== null);
  check('reply: a reply naming no thread is refused',
    replyRejection(reply({ threadId: '' }), 'file:///a.md', 'Open') !== null);
  check('reply: a reply to an unknown thread is refused',
    replyRejection(reply(), 'file:///a.md', undefined) !== null);

  const del = (over: Partial<DeleteCommentMessage> = {}): DeleteCommentMessage => ({
    type: 'deleteComment',
    requestId: 1,
    docUri: 'file:///a.md',
    threadId: 'thread-1',
    ...over,
  });
  check('delete: the content author may delete their own content',
    deleteRejection(del(), 'file:///a.md', { author: 'hungvu' }, 'hungvu') === null);
  // The soft, non-authenticated nudge — not a security boundary (US-23.3 AC6).
  check('delete: another author is refused',
    deleteRejection(del(), 'file:///a.md', { author: 'someone-else' }, 'hungvu') !== null);
  // The same name typed on macOS (NFD) and Windows (NFC) is one person — the
  // two literals below are genuinely different strings before normalization.
  check('delete: the NFD and NFC author names are genuinely different strings',
    'Nguyễn'.normalize('NFD') !== 'Nguyễn'.normalize('NFC'));
  check('delete: author matching is NFC-normalized',
    deleteRejection(del(), 'file:///a.md', { author: 'Nguyễn'.normalize('NFD') }, 'Nguyễn'.normalize('NFC')) === null);
  check('delete: a vanished target is refused',
    deleteRejection(del(), 'file:///a.md', undefined, 'hungvu') !== null);
  check('delete: a delete for another document is refused',
    deleteRejection(del(), 'file:///b.md', { author: 'hungvu' }, 'hungvu') !== null);
  check('delete: a delete naming no thread is refused',
    deleteRejection(del({ threadId: '' }), 'file:///a.md', { author: 'hungvu' }, 'hungvu') !== null);

  // The field sets are frozen by the requirement's "Sidecar Schema Decision"
  // section — a drift here is a data-format break, not a cosmetic one.
  const replyLine = buildReplyLine({
    id: 'e8a2f4d1',
    parentCommentId: 'b3f1c2a0',
    author: 'otheruser',
    timestamp: '2026-07-26T14:03:11.900Z',
    body: 'Fixed, please re-check.',
  });
  check('reply line: carries exactly the declared field set',
    JSON.stringify(Object.keys(replyLine).sort()) ===
      JSON.stringify(['author', 'body', 'id', 'parent_comment_id', 'schema_version', 'timestamp', 'type'].sort()));
  check('reply line: type is "reply" and it names its parent',
    replyLine.type === 'reply' && replyLine.parent_comment_id === 'b3f1c2a0');

  const deleteLine = buildDeleteLine({
    id: '4a71e990',
    targetId: 'e8a2f4d1',
    author: 'otheruser',
    timestamp: '2026-07-26T16:05:00.000Z',
  });
  check('delete line: carries exactly the declared field set',
    JSON.stringify(Object.keys(deleteLine).sort()) ===
      JSON.stringify(['author', 'id', 'schema_version', 'target_id', 'timestamp', 'type'].sort()));
  check('delete line: type is "delete" and it names its target',
    deleteLine.type === 'delete' && deleteLine.target_id === 'e8a2f4d1');
}

// --- Req 23 US-23.3: two-step resolve (Open -> Resolved -> Closed) ----------
{
  const statusLine = buildStatusChangeLine({
    id: '9c40aa77',
    parentCommentId: 'b3f1c2a0',
    author: 'hungvu',
    timestamp: '2026-07-26T15:10:00.000Z',
    fromStatus: 'Open',
    toStatus: 'Resolved',
  });
  check('status-change line: carries exactly the declared field set',
    JSON.stringify(Object.keys(statusLine).sort()) ===
      JSON.stringify(
        ['author', 'from_status', 'id', 'parent_comment_id', 'schema_version', 'timestamp', 'to_status', 'type'].sort()
      ));
  check('status-change line: type is "status-change" and it names its parent and both ends of the move',
    statusLine.type === 'status-change' &&
      statusLine.parent_comment_id === 'b3f1c2a0' &&
      statusLine.from_status === 'Open' &&
      statusLine.to_status === 'Resolved');
  // A Reopen has to say which of Resolved/Closed it undid (AC5) — the fold only
  // reads to_status, so from_status exists purely to keep the history readable.
  check('status-change line: a Reopen records which status it undid',
    buildStatusChangeLine({
      id: 's9',
      parentCommentId: 'c1',
      author: 'mai',
      timestamp: '2026-07-26T16:00:00.000Z',
      fromStatus: 'Closed',
      toStatus: 'Open',
    }).from_status === 'Closed');

  const move = (over: Partial<StatusChangeMessage> = {}): StatusChangeMessage => ({
    type: 'changeCommentStatus',
    requestId: 1,
    docUri: 'file:///a.md',
    threadId: 't1',
    action: 'resolve',
    ...over,
  });
  // US-23.11 AC1: every transition is legal for WHOEVER is at the keyboard. The
  // thread's recorded author is no longer an input to the validator at all —
  // which is exactly what the arity check below pins.
  const close = move({ action: 'close' });
  const reopen = move({ action: 'reopen' });
  check('US-23.11 AC1: identity is not an input — the validator takes no author',
    statusChangeRejection.length === 3);
  check('US-23.11 AC1: an Open thread may be resolved, whoever is asking',
    statusChangeRejection(move(), 'file:///a.md', 'Open') === null);
  check('US-23.11 AC1: the thread author may close a Resolved thread',
    statusChangeRejection(close, 'file:///a.md', 'Resolved') === null);
  check('US-23.11 AC1: the thread author may reopen their own Resolved thread',
    statusChangeRejection(reopen, 'file:///a.md', 'Resolved') === null);
  check('US-23.11 AC1: the thread author may reopen their own Closed thread — no lockout',
    statusChangeRejection(reopen, 'file:///a.md', 'Closed') === null);

  // US-23.11 AC5: the full matrix, enforced on the status axis alone.
  // Open -> Resolve only; Resolved -> Close and Reopen; Closed -> Reopen.
  const MATRIX: Record<CommentStatus, StatusChangeMessage['action'][]> = {
    Open: ['resolve'],
    Resolved: ['close', 'reopen'],
    Closed: ['reopen'],
  };
  check('US-23.11 AC5: exactly the legal action set is permitted from each status',
    (['Open', 'Resolved', 'Closed'] as const).every((status) =>
      (['resolve', 'close', 'reopen'] as const).every(
        (act) =>
          (statusChangeRejection(move({ action: act }), 'file:///a.md', status) === null) ===
          MATRIX[status].includes(act)
      )
    ));
  // The status reason must still name the workflow step, not a permission.
  check('close: an Open thread reports the status reason',
    statusChangeRejection(close, 'file:///a.md', 'Open') ===
      'Resolve the thread before closing it.');
  // AC7's second half, and the reason no transition can be appended twice: no
  // action is legal from the status it produces.
  check('status change: no action is legal from the status it produces',
    (['resolve', 'close', 'reopen'] as const).every(
      (act) =>
        statusChangeRejection(move({ action: act }), 'file:///a.md', STATUS_CHANGE_TARGET[act]) !==
        null
    ));
  // Reopen must land on Open in ONE step (AC5) — not Closed -> Resolved -> Open.
  check('status change: reopen from either Resolved or Closed lands on Open in one step',
    STATUS_CHANGE_TARGET.reopen === 'Open' &&
      statusChangeRejection(reopen, 'file:///a.md', 'Resolved') === null &&
      statusChangeRejection(reopen, 'file:///a.md', 'Closed') === null);

  // Same untrusted-input rules every other comment validator carries.
  check('status change: a request for another document is refused',
    statusChangeRejection(move(), 'file:///b.md', 'Open') !== null);
  check('status change: a request naming no thread is refused',
    statusChangeRejection(move({ threadId: '' }), 'file:///a.md', 'Open') !== null);
  check('status change: a vanished thread is refused',
    statusChangeRejection(move(), 'file:///a.md', undefined) !== null);
  // An unknown action must be refused outright: falling through would look up
  // `undefined` as the target status and append a malformed sidecar line.
  check('status change: an unknown action is refused',
    statusChangeRejection(
      move({ action: 'archive' as StatusChangeMessage['action'] }),
      'file:///a.md',
      'Open'
    ) !== null);

  // --- contextValue <-> package.json `when` clauses ------------------------
  //
  // The native Resolve/Close/Reopen actions are visible only when the thread's
  // contextValue matches its command's `when` regex. A typo on EITHER side removes
  // all three from the Comments UI with nothing failing anywhere, so the two are
  // pinned against each other here rather than trusted to stay in sync.
  // `process.cwd()`, matching the `src/provider.ts` read above: this suite is
  // compiled into `dist/test/`, so `__dirname` would resolve to `dist/`.
  const pkg = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
  ) as { contributes: { menus: Record<string, Array<{ command: string; when: string }>> } };
  const threadMenu = pkg.contributes.menus['comments/commentThread/context'];
  const whenFor = (command: string): string =>
    threadMenu.find((entry) => entry.command === `orcaEditor.${command}Comment`)?.when ?? '';
  /** The `commentThread =~ /…/` half of a `when` clause, as a live RegExp. */
  const clauseRegex = (command: string): RegExp => {
    const source = /commentThread\s*=~\s*\/(.+?)\//.exec(whenFor(command))?.[1];
    return new RegExp(source ?? '(?!)');
  };

  check('contextValue: every status/anchor pair carries both axes',
    (['exact', 'approximate', 'floating'] as const).every((anchorState) =>
      (['Open', 'Resolved', 'Closed'] as const).every((status) => {
        const value = commentThreadContextValue(anchorState, status);
        return value.includes(`anchor-${anchorState}`) && value.includes(`status-${status.toLowerCase()}`);
      })
    ));
  // The matrix the two-step flow depends on: exactly which of the three actions
  // the native menu offers per status (anchor state must never affect it).
  const offered = (status: 'Open' | 'Resolved' | 'Closed'): string[] =>
    (['resolve', 'close', 'reopen'] as const).filter((command) =>
      clauseRegex(command).test(commentThreadContextValue('exact', status))
    );
  check('contextValue: an Open thread offers Resolve only',
    JSON.stringify(offered('Open')) === JSON.stringify(['resolve']));
  check('contextValue: a Resolved thread offers Close and Reopen',
    JSON.stringify(offered('Resolved')) === JSON.stringify(['close', 'reopen']));
  check('contextValue: a Closed thread offers Reopen only',
    JSON.stringify(offered('Closed')) === JSON.stringify(['reopen']));
  // The anchor half must not leak into the status clauses — a drifted or floating
  // thread still needs its transitions.
  check('contextValue: the anchor state never changes which actions are offered',
    (['approximate', 'floating'] as const).every((anchorState) =>
      (['Open', 'Resolved', 'Closed'] as const).every((status) => {
        const drifted = (['resolve', 'close', 'reopen'] as const).filter((command) =>
          clauseRegex(command).test(commentThreadContextValue(anchorState, status))
        );
        return JSON.stringify(drifted) === JSON.stringify(offered(status));
      })
    ));
  // Every one of the three must be palette-hidden: they take a `CommentReply`
  // argument and throw on a bare invocation.
  check('contextValue: all three commands are hidden from the Command Palette',
    (['resolve', 'close', 'reopen'] as const).every((command) =>
      pkg.contributes.menus.commandPalette.some(
        (entry) => entry.command === `orcaEditor.${command}Comment` && entry.when === 'false'
      )
    ));
}

// --- Req 24 US-23.13 AC6: cross-panel resolver authority --------------------
{
  check('nextAuthoritativePanel: an empty set has no survivor',
    nextAuthoritativePanel([]) === undefined);
  check('nextAuthoritativePanel: a single remaining panel is picked',
    nextAuthoritativePanel(['panelA']) === 'panelA');
  check('nextAuthoritativePanel: several remaining panels pick the first in iteration order',
    nextAuthoritativePanel(new Set(['panelA', 'panelB', 'panelC'])) === 'panelA');
  check('nextAuthoritativePanel: does not depend on array vs Set — same order either way',
    nextAuthoritativePanel(['panelB', 'panelA']) === 'panelB');
}

// --- Req 23 US-23.11 AC3: the one-directional content-drift measure ---------
{
  const RECORDED = 'The refund drains the queued session before the retry window closes.';
  const band = driftBandFor(RECORDED);
  /** The enter edge, i.e. a thread that is not currently latched into drift. */
  const drifted = (recorded: string, current: string): boolean => {
    const enter = driftBandFor(recorded).enter;
    return anchorTextRetention(recorded, current, enter) < enter;
  };
  /** Retention measured at a threshold low enough that the early bail never fires. */
  const retentionOf = (recorded: string, current: string): number =>
    anchorTextRetention(recorded, current, 0);

  check('drift: identical text is fully retained',
    retentionOf(RECORDED, RECORDED) === 1);
  // Re-wrapping a paragraph changes no words, so it must not read as drift.
  check('drift: re-wrapped whitespace is fully retained',
    retentionOf(RECORDED, RECORDED.replace(/ /g, '\n  ')) === 1);
  // THE bug US-23.11 AC3 exists for: text typed into the paragraph AFTER the
  // comment was written is text outside the comment and is not drift, however
  // much of it there is. The old symmetric score divided by the longer string,
  // so this read as drift.
  check('drift: appending a whole sentence is not drift',
    retentionOf(RECORDED, `${RECORDED} A brand new sentence follows it now.`) === 1 &&
      !drifted(RECORDED, `${RECORDED} A brand new sentence follows it now.`));
  check('drift: a one-word tweak is not drift',
    !drifted(RECORDED, RECORDED.replace('drains', 'clears')));
  // ...but removing or rewriting the recorded text is, one-directionally.
  check('drift: half the paragraph rewritten is drift',
    drifted(RECORDED, 'The refund drains the queued session ' + 'and then something else entirely happens here.'));
  check('drift: a rewritten sentence is drift',
    drifted(RECORDED, 'Totally different prose about something else entirely here.'));
  check('drift: deleted-to-nothing retains none of the snapshot',
    retentionOf(RECORDED, '') === 0 && drifted(RECORDED, ''));
  // An empty recorded text has nothing to drift from — never report drift on it,
  // or every bare-caret anchor would show the strip forever.
  check('drift: an empty recorded text is always fully retained',
    retentionOf('', 'anything at all') === 1);
  // The same prose typed on macOS vs Windows differs only by Unicode form.
  check('drift: NFD vs NFC of the same prose is not drift',
    retentionOf('Nguyễn Văn A'.normalize('NFD'), 'Nguyễn Văn A'.normalize('NFC')) === 1);

  // AC3: the drift band is the drift check's OWN, not tier 2's relocation pair.
  check('drift: the band is independent of tier 2 thresholds',
    band.enter !== anchorThresholdFor(RECORDED) && band.enter < band.exit);
  // Short text gets a MORE permissive band, not tier 2's stricter one: one
  // character edited in a ten-character heading is not "the text may have
  // changed", while half of it rewritten is.
  const short = driftBandFor('Done');
  check('drift: short text uses a more permissive band than ordinary text',
    short.enter < band.enter && short.enter < short.exit);
  check('drift: a one-character change to a short heading is not drift',
    !drifted('Session expiry', 'Session expiries'));
  check('drift: a short heading rewritten IS drift',
    drifted('Done', 'Not applicable'));

  // AC3's hysteresis, exercised as `applyStatusIndicators` runs it: the edge in
  // play depends on the state the thread is ALREADY in, so a retention sitting
  // between the two edges holds that state instead of flickering.
  const latch = (recorded: string, current: string, wasDrifted: boolean): boolean => {
    const band = driftBandFor(recorded);
    const threshold = wasDrifted ? band.exit : band.enter;
    return anchorTextRetention(recorded, current, threshold) < threshold;
  };
  const HYSTERESIS = 'A short paragraph of prose that a single keystroke can nudge across the line.';
  const edge = HYSTERESIS.slice(0, Math.round(HYSTERESIS.length * 0.92));
  const retention = retentionOf(HYSTERESIS, edge);
  check('drift: the band leaves room between enter and exit for hysteresis',
    retention > driftBandFor(HYSTERESIS).enter && retention < driftBandFor(HYSTERESIS).exit);
  check('drift: inside the band an undrifted thread stays undrifted',
    !latch(HYSTERESIS, edge, false));
  check('drift: inside the band a drifted thread stays drifted',
    latch(HYSTERESIS, edge, true));
  // ...and both edges still resolve outside the band, so the latch is hysteresis
  // and not a state that can never be left.
  check('drift: a full restore clears drift even from the latched state',
    !latch(HYSTERESIS, HYSTERESIS, true));
  check('drift: a heavy deletion enters drift even from the clean state',
    latch(HYSTERESIS, HYSTERESIS.slice(0, 20), false));

  // The early bail must never change the ANSWER, only the work: a current text
  // too short to clear the threshold returns its own upper bound, which is below
  // the threshold exactly when the full pass would have been.
  const BAIL = 'The refund drains the queued session before the retry window closes.';
  check('drift: the length bail agrees with the full pass',
    (anchorTextRetention(BAIL, BAIL.slice(0, 10), 0.9) < 0.9) ===
      (retentionOf(BAIL, BAIL.slice(0, 10)) < 0.9));
  // Text inserted BEFORE the snapshot, past the compare cap, is still not drift —
  // capping both sides at the same absolute prefix used to cut the snapshot's own
  // tail out of the window and report drift for an edit that removed nothing.
  const LONG = 'x'.repeat(400);
  check('drift: a long insertion BEFORE the snapshot is not drift',
    !drifted(LONG, `${'y'.repeat(200)} ${LONG}`));
}

// --- Req 23 US-23.2 AC1: gutter-pin line clustering -------------------------
{
  const at = (line: number, threadId = `t${line}`): ThreadAnchor =>
    ({ threadId, lastKnownLine: line, replies: [] }) as unknown as ThreadAnchor;
  const lines = (groups: ThreadAnchor[][]): number[][] => groups.map((g) => g.map((a) => a.lastKnownLine));

  check('pin cluster: one thread is its own group',
    JSON.stringify(lines(buildGroups([at(3)]))) === JSON.stringify([[3]]));
  // One pin per gutter line: a gap of any size — including the 2 the superseded
  // blank-line window merged — keeps the threads on separate pins.
  check('pin cluster: lines 2 apart each keep their own group',
    JSON.stringify(lines(buildGroups([at(3), at(5), at(7)]))) === JSON.stringify([[3], [5], [7]]));
  check('pin cluster: adjacent lines keep their own group',
    JSON.stringify(lines(buildGroups([at(3), at(4)]))) === JSON.stringify([[3], [4]]));
  check('pin cluster: two threads on the SAME line are one group',
    JSON.stringify(lines(buildGroups([at(4, 'a'), at(4, 'b')]))) === JSON.stringify([[4, 4]]));
  // Ids, not just lines: a same-line group's order IS the chooser's row order, so
  // the sort has to stay stable over equal lines.
  check('pin cluster: input order does not matter, and a group keeps its own order',
    JSON.stringify(buildGroups([at(7), at(3, 'a'), at(3, 'b')]).map((g) => g.map((a) => a.threadId))) ===
      JSON.stringify([['a', 'b'], ['t7']]));
  // Line 0 is `commentAnchorLine`'s "maps to no source line" fallback, NOT line
  // zero: grouping those by value collapsed unrelated threads from opposite ends
  // of the document onto one pin and left the others with no marker at all.
  check('pin cluster: unknown-line (0) threads each keep their own group',
    JSON.stringify(lines(buildGroups([at(0, 'a'), at(0, 'b')]))) === JSON.stringify([[0], [0]]));
  check('pin cluster: an unknown-line thread never joins a real-line group',
    JSON.stringify(lines(buildGroups([at(0, 'a'), at(1)]))) === JSON.stringify([[0], [1]]));
}

// --- Req 23 US-23.4 AC4: Re-attach... picker ranking ------------------------
{
  const candidate = (text: string, line: number, heading = '', depth = 1): AnchorCandidate => ({
    text,
    line,
    heading,
    depth,
  });
  const nodes = [
    candidate('REQ-118 — Session Expiry', 1, '', 1),
    candidate('AC-1 — Refund requests raised against an expired session are held.', 11, 'Acceptance criteria'),
    candidate('AC-2 — The held queue drains in enqueue order.', 12, 'Acceptance criteria'),
    candidate('AC-3 — Each entry records a reason code.', 13, 'Acceptance criteria'),
  ];
  const recorded = 'AC-2 — The held queue drains in enqueue order.';

  const ranked = rankReattachTargets(recorded, nodes, '');
  check('re-attach: every node is offered when the filter is empty', ranked.all.length === 4);
  check('re-attach: the closest node is suggested first', ranked.suggested[0]?.index === 2);
  check('re-attach: the exact node scores 100%', Math.round((ranked.suggested[0]?.score ?? 0) * 100) === 100);
  check('re-attach: suggestions are capped', rankReattachTargets(recorded, nodes, '', 2).suggested.length === 2);
  // Suggestions are ranked, never applied — the picker always leaves the choice
  // to the author, which is why every candidate stays listed under Suggested.
  check('re-attach: a runner-up is still offered, not discarded', (ranked.suggested[1]?.index ?? -1) !== -1);

  const filtered = rankReattachTargets(recorded, nodes, 'QUEUE');
  check('re-attach: the filter is case-insensitive', filtered.all.length === 1 && filtered.all[0].index === 2);
  check('re-attach: a filter matching nothing yields no rows',
    rankReattachTargets(recorded, nodes, 'zzz').all.length === 0);
  check('re-attach: the filter is normalized like every other text comparison',
    rankReattachTargets('x', [candidate('Nhật ký phiên'.normalize('NFD'), 3)], 'Nhật'.normalize('NFC')).all.length === 1);
  check('re-attach: no candidates means no rows', rankReattachTargets(recorded, [], '').all.length === 0);
  check('re-attach: an empty recorded text still lists every node, just unranked',
    rankReattachTargets('', nodes, '').all.length === 4 && rankReattachTargets('', nodes, '').suggested.length === 0);
}

// --- Req 23 US-23.5: .orca-comments.jsonl sidecar format --------------------
{
  const anchor = {
    offset_start: 0,
    offset_end: 5,
    recorded_text: 'AC-1 — held',
    last_known_line: 88,
    nearest_heading: 'Acceptance criteria',
  };
  const comment = (over: Partial<CommentLine> = {}): CommentLine => ({
    ...buildCommentLine({
      id: 'c1',
      author: 'reviewer',
      timestamp: '2026-07-26T10:00:00.000Z',
      body: 'why?',
      anchor,
    }),
    ...over,
  });
  const reply = (over: Partial<ReplyLine> = {}): ReplyLine => ({
    schema_version: 1,
    type: 'reply',
    id: 'r1',
    parent_comment_id: 'c1',
    author: 'author',
    timestamp: '2026-07-26T11:00:00.000Z',
    body: 'fixed',
    ...over,
  });
  const statusChange = (over: Partial<StatusChangeLine> = {}): StatusChangeLine => ({
    schema_version: 1,
    type: 'status-change',
    id: 's1',
    parent_comment_id: 'c1',
    author: 'author',
    timestamp: '2026-07-26T12:00:00.000Z',
    from_status: 'Open',
    to_status: 'Resolved',
    ...over,
  });
  const tombstone = (over: Partial<DeleteLine> = {}): DeleteLine => ({
    schema_version: 1,
    type: 'delete',
    id: 'd1',
    target_id: 'r1',
    author: 'author',
    timestamp: '2026-07-26T13:00:00.000Z',
    ...over,
  });

  // AC1/AC3: 1:1 sibling name, and every append ends the line so two concurrent
  // appends land as separate diff hunks instead of colliding on one line region.
  check('sidecar: the file is a 1:1 sibling of the .md', sidecarNameFor('foo.md') === 'foo.md.orca-comments.jsonl');
  const serialized = serializeSidecarLine(comment());
  check('sidecar: a serialized line ends with a newline', serialized.endsWith('\n'));
  check('sidecar: a serialized record is exactly one physical line',
    serialized.slice(0, -1).includes('\n') === false);
  // A multi-line body must not break the line-oriented format.
  check('sidecar: a body containing newlines still serializes to one line',
    serializeSidecarLine(comment({ body: 'line one\nline two' })).slice(0, -1).includes('\n') === false);
  check('sidecar: a serialized line round-trips',
    parseSidecarText(serialized).lines.length === 1 &&
      (parseSidecarText(serialized).lines[0] as CommentLine).body === 'why?');
  check('sidecar: no status is stored on the comment line',
    Object.prototype.hasOwnProperty.call(comment(), 'status') === false);
  check('sidecar: the session-scoped structural id is never persisted',
    Object.prototype.hasOwnProperty.call(comment().anchor, 'anchorId') === false &&
      Object.prototype.hasOwnProperty.call(comment().anchor, 'structuralId') === false);

  // AC4: an unparseable line is skipped with a warning, never aborting the load —
  // a crashed append leaves at most one truncated final line.
  const withGarbage = `${serializeSidecarLine(comment())}{"schema_version":1,"type":"comm\n${serializeSidecarLine(comment({ id: 'c2' }))}`;
  const parsedGarbage = parseSidecarText(withGarbage);
  check('sidecar: a corrupt line is skipped, the rest still load', parsedGarbage.lines.length === 2);
  check('sidecar: a skipped line is reported', parsedGarbage.warnings.length === 1);
  check('sidecar: a blank line is not a warning', parseSidecarText('\n\n').warnings.length === 0);
  // JSON that parses but is not a record must not reach the fold.
  check('sidecar: valid JSON of the wrong shape is skipped',
    parseSidecarText('{"type":"comment","id":"x"}\n').lines.length === 0);
  check('sidecar: a record with no id is skipped',
    parseSidecarText(serializeSidecarLine(comment({ id: '' }))).lines.length === 0);
  check('sidecar: an unknown line type is skipped',
    parseSidecarText('{"schema_version":1,"type":"reaction","id":"x","author":"a","timestamp":"2026-01-01T00:00:00Z"}\n')
      .lines.length === 0);

  // Req 24 US-23.15 AC4: a conflicted merge is a stated failure, not a silently
  // partial list — the markers are skipped like any unparseable line, but the
  // file is FLAGGED so the caller can say "unresolved merge" rather than "damaged".
  const conflicted = parseSidecarText(
    [
      '<<<<<<< HEAD',
      serializeSidecarLine(comment()).trimEnd(),
      '=======',
      serializeSidecarLine(comment({ id: 'c2' })).trimEnd(),
      '>>>>>>> feature/other',
      '',
    ].join('\n')
  );
  check('sidecar: conflict markers are skipped and both sides still load', conflicted.lines.length === 2);
  check('sidecar: a conflicted sidecar is flagged', conflicted.conflicted === true);
  check('sidecar: each conflict marker is reported as its own loss', conflicted.warnings.length === 3);
  // The marker count is what keeps AC3's "N line(s) could not be read" honest: a
  // marker carries no comment data, so all three warnings here describe a merge in
  // which nothing was actually lost.
  check('sidecar: marker lines are counted separately from real losses', conflicted.conflictMarkers === 3);
  const diff3 = parseSidecarText(
    ['<<<<<<< HEAD', '||||||| base', '=======', serializeSidecarLine(comment()).trimEnd(), '>>>>>>> other', ''].join('\n')
  );
  check("sidecar: diff3's ||||||| base marker is a marker, not bad JSON", diff3.conflictMarkers === 4);
  check('sidecar: diff3 style still loads the surviving record', diff3.lines.length === 1);
  check('sidecar: a conflict marker is named as one, not as bad JSON',
    conflicted.warnings.every((w) => w.includes('git conflict marker')));
  check('sidecar: a clean sidecar is not flagged as conflicted',
    parseSidecarText(serializeSidecarLine(comment())).conflicted === undefined);
  // Only at the START of a line: `=======` inside a comment body is prose, and the
  // body is inside a JSON string, so the line must still parse.
  check('sidecar: a body containing a conflict marker still parses',
    parseSidecarText(serializeSidecarLine(comment({ body: '======= not a marker' }))).lines.length === 1);
  check('sidecar: a body containing a conflict marker does not flag the file',
    parseSidecarText(serializeSidecarLine(comment({ body: '<<<<<<< nope' }))).conflicted === undefined);

  // Req 24 US-23.15 AC5: git state → the warning the user reads. `shared` is the
  // healthy case; outside a repository (or with no usable `git`) AC5 is a no-op.
  check('sidecar git: an ignored sidecar warns about the ignore rule',
    (sidecarShareWarning('ignored', 'a.md.orca-comments.jsonl') ?? '').includes('gitignore'));
  check('sidecar git: an untracked sidecar warns to add it',
    (sidecarShareWarning('untracked', 'a.md.orca-comments.jsonl') ?? '').includes('git add'));
  check('sidecar git: a warning names the sidecar',
    (sidecarShareWarning('untracked', 'a.md.orca-comments.jsonl') ?? '').includes('a.md.orca-comments.jsonl'));
  check('sidecar git: a tracked sidecar says nothing', sidecarShareWarning('shared', 'a.jsonl') === null);
  check('sidecar git: outside a git repository says nothing', sidecarShareWarning('no-repo', 'a.jsonl') === null);
  check('sidecar git: an unusable git says nothing', sidecarShareWarning('unknown', 'a.jsonl') === null);

  // Req 24 US-23.18 AC6: the gate that decides whether a webview undo/redo may become a
  // GLOBAL `executeCommand`. The handler consulting it cannot be reached from the host
  // track (no public API opens a custom editor's webview to post to it), so this is where
  // the decision itself is proven.
  const ledgerAfter = (...reasons: UndoLedgerReason[]): UndoLedger =>
    reasons.reduce(recordUndoLedgerChange, emptyUndoLedger());
  // AC6's own precondition: a file opened and never edited owns no step, so nothing may
  // be forwarded. This is the case that used to revert the user's last file rename.
  check('undo ledger: an untouched document forwards neither undo nor redo',
    !canForwardUndo(ledgerAfter(), 'undo') && !canForwardUndo(ledgerAfter(), 'redo'));
  check('undo ledger: a document never seen at all forwards nothing',
    !canForwardUndo(undefined, 'undo') && !canForwardUndo(undefined, 'redo'));
  check('undo ledger: one edit makes undo forwardable but not redo',
    canForwardUndo(ledgerAfter('edit'), 'undo') && !canForwardUndo(ledgerAfter('edit'), 'redo'));
  check('undo ledger: undoing the only edit leaves redo forwardable and undo not',
    !canForwardUndo(ledgerAfter('edit', 'undo'), 'undo') &&
      canForwardUndo(ledgerAfter('edit', 'undo'), 'redo'));
  check('undo ledger: redoing restores the undo side',
    canForwardUndo(ledgerAfter('edit', 'undo', 'redo'), 'undo') &&
      !canForwardUndo(ledgerAfter('edit', 'undo', 'redo'), 'redo'));
  // VS Code discards the redone-away future once you type again; so does this.
  check('undo ledger: a fresh edit clears the redo side',
    !canForwardUndo(ledgerAfter('edit', 'undo', 'edit'), 'redo'));
  check('undo ledger: depth accumulates across edits',
    ledgerAfter('edit', 'edit', 'edit').undoable === 3);
  check('undo ledger: two edits survive one undo',
    canForwardUndo(ledgerAfter('edit', 'edit', 'undo'), 'undo'));
  // An unpaired event — the document was already open before the ledger existed — must
  // degrade to "nothing known", never to a negative count that poisons later decisions.
  check('undo ledger: an unpaired undo floors at zero rather than going negative',
    ledgerAfter('undo').undoable === 0 && !canForwardUndo(ledgerAfter('undo', 'redo', 'undo'), 'undo'));
  check('undo ledger: an unpaired redo floors the redo side at zero',
    ledgerAfter('redo').redoable === 0);
  // The reason mapping is the seam to `vscode.TextDocumentChangeReason` (Undo = 1,
  // Redo = 2, everything else undefined) — a wrong constant here would silently invert
  // the whole state machine.
  check('undo ledger: reason 1 is an undo, 2 a redo, undefined a fresh edit',
    undoLedgerReasonOf(1) === 'undo' && undoLedgerReasonOf(2) === 'redo' &&
      undoLedgerReasonOf(undefined) === 'edit');
  check('undo ledger: an unknown reason code counts as a fresh edit',
    undoLedgerReasonOf(99) === 'edit');
  // The blocker this review caught: git answers "untracked" for a path that does
  // not exist, so without its own state every never-commented document would be
  // told to `git add` a file nobody has created.
  check('sidecar git: a document with no sidecar yet says nothing',
    sidecarShareWarning('no-sidecar', 'a.jsonl') === null);

  // AC5's state machine itself is async, and this runner is CJS with no
  // top-level await — it is driven (through the same injectable runner, plus a
  // real `git init`) in `test/host/sidecar-reload.test.ts`.

  // AC4: timestamp order, not on-disk order — a git merge can interleave lines.
  const shuffled = foldSidecarRecords([
    comment(),
    reply({ id: 'r2', timestamp: '2026-07-26T11:30:00.000Z', body: 'second' }),
    reply({ id: 'r1', timestamp: '2026-07-26T11:00:00.000Z', body: 'first' }),
  ]);
  check('sidecar: replies are ordered by timestamp, not disk order',
    shuffled.threads[0].replies.map((r) => r.body).join(',') === 'first,second');

  // AC3 (third rule): a reply/status-change/anchor-update is never ordered
  // before its own parent regardless of its timestamp — each is stored in its
  // own per-thread array, never interleaved with the parent `comment`, so an
  // earlier-than-parent timestamp cannot misplace it ahead of its own thread.
  const replyBeforeParent = foldSidecarRecords([
    comment(), // created 2026-07-26T10:00:00.000Z
    reply({ timestamp: '2026-07-26T05:00:00.000Z', body: 'timestamped before its own parent comment' }),
  ]);
  check('sidecar: a reply timestamped before its own parent still folds into that parent\'s thread',
    replyBeforeParent.threads.length === 1 &&
      replyBeforeParent.threads[0].replies.length === 1 &&
      replyBeforeParent.threads[0].replies[0].body === 'timestamped before its own parent comment' &&
      replyBeforeParent.orphans.length === 0);

  // AC4: first-seen wins on a duplicate id, and the rest are flagged.
  const duplicated = foldSidecarRecords([comment({ body: 'first' }), comment({ body: 'second' })]);
  check('sidecar: a duplicate comment id keeps the first-seen line',
    duplicated.threads.length === 1 && duplicated.threads[0].comment.body === 'first');
  check('sidecar: a duplicate comment id is flagged', duplicated.warnings.length === 1);

  // AC4: an unmatched parent routes to orphans instead of being dropped.
  const orphaned = foldSidecarRecords([comment(), reply({ parent_comment_id: 'missing' })]);
  check('sidecar: a reply with no parent routes to orphans',
    orphaned.orphans.length === 1 && orphaned.threads[0].replies.length === 0);
  check('sidecar: a status change with no parent routes to orphans',
    foldSidecarRecords([statusChange({ parent_comment_id: 'missing' })]).orphans.length === 1);
  // AC7's literal example: a reply whose parent_comment_id names ANOTHER
  // reply (not a comment) — reply-to-reply nesting is exactly one level too
  // deep, so it orphans the same way a missing/unknown parent does.
  check('sidecar: a reply-to-reply (parent names another reply, not a comment) routes to orphans',
    foldSidecarRecords([comment(), reply({ id: 'r1' }), reply({ id: 'r2', parent_comment_id: 'r1' })]).orphans.length === 1);

  // Status is derived by folding status-change lines, never stored.
  check('sidecar: a thread with no status change defaults to Open',
    foldSidecarRecords([comment()]).threads[0].status === 'Open');
  check('sidecar: status folds to the last change by timestamp',
    foldSidecarRecords([
      comment(),
      statusChange({ id: 's2', timestamp: '2026-07-26T14:00:00.000Z', from_status: 'Resolved', to_status: 'Closed' }),
      statusChange(),
    ]).threads[0].status === 'Closed');
  check('sidecar: a reopen folds back to Open',
    foldSidecarRecords([
      comment(),
      statusChange(),
      statusChange({ id: 's3', timestamp: '2026-07-26T15:00:00.000Z', from_status: 'Resolved', to_status: 'Open' }),
    ]).threads[0].status === 'Open');

  // US-23.11 AC6: `from_status` is a guard, not a note. A line whose recorded
  // origin disagrees with what the strictly-earlier lines folded to is SKIPPED —
  // a hand-edited file or a git merge cannot land an illegal Open -> Closed jump
  // that no control would ever have offered.
  const illegalJump = foldSidecarRecords([
    comment(),
    statusChange({ id: 'sX', from_status: 'Resolved', to_status: 'Closed' }),
  ]);
  check('US-23.11 AC6: a status-change from the wrong status is skipped, not applied',
    illegalJump.threads[0].status === 'Open');
  check('US-23.11 AC6: the skipped transition is still flagged',
    illegalJump.warnings.length === 1);
  check('US-23.11 AC6: a skipped transition is dropped from the thread trail',
    illegalJump.threads[0].statusChanges.length === 0);
  // ...and the fold carries on: a legal line AFTER a skipped one still applies,
  // measured against the status the skip preserved.
  const skipThenApply = foldSidecarRecords([
    comment(),
    statusChange({ id: 'sX', timestamp: '2026-07-26T12:00:00.000Z', from_status: 'Closed', to_status: 'Open' }),
    statusChange({ id: 'sY', timestamp: '2026-07-26T13:00:00.000Z', from_status: 'Open', to_status: 'Resolved' }),
  ]);
  check('US-23.11 AC6: a legal transition after a skipped one still applies',
    skipThenApply.threads[0].status === 'Resolved' &&
      skipThenApply.threads[0].statusChanges.length === 1);
  // AC2 reads this list straight through to the popover, so its order and
  // contents are part of the loader's contract.
  const trail = foldSidecarRecords([
    comment(),
    statusChange({ id: 's3', timestamp: '2026-07-26T15:00:00.000Z', from_status: 'Resolved', to_status: 'Closed', author: 'mai' }),
    statusChange({ id: 's1', timestamp: '2026-07-26T12:00:00.000Z', from_status: 'Open', to_status: 'Resolved', author: 'hungvu' }),
  ]).threads[0].statusChanges;
  check('US-23.11 AC2: the whole applied trail survives the fold, oldest first',
    trail.length === 2 &&
      trail[0].to_status === 'Resolved' && trail[0].author === 'hungvu' &&
      trail[1].to_status === 'Closed' && trail[1].author === 'mai');

  // Tombstones: applied last, cascade for a comment, single for a reply.
  const replyDeleted = foldSidecarRecords([comment(), reply(), reply({ id: 'r2' }), tombstone()]);
  check('sidecar: deleting a reply leaves the thread and its siblings',
    replyDeleted.threads.length === 1 && replyDeleted.threads[0].replies.length === 1 &&
      replyDeleted.threads[0].replies[0].id === 'r2');
  const threadDeleted = foldSidecarRecords([
    comment(),
    reply(),
    statusChange(),
    tombstone({ target_id: 'c1', author: 'reviewer' }),
  ]);
  check('sidecar: deleting a comment cascades to its replies and status changes',
    threadDeleted.threads.length === 0 && threadDeleted.orphans.length === 0);
  // AC8: no authority check — a delete from a different author than its target
  // is still applied (the same PO call US-23.11 already made for status-change).
  check('sidecar: a delete from a different author than the target is still applied (AC8)',
    foldSidecarRecords([comment(), reply(), tombstone({ author: 'someone-else' })]).threads[0].replies.length === 0);

  // US-23.11 AC9: the one author normalizer — decode, trim, NFC, case-fold — and
  // a blank side that never matches anything. Nothing in the FOLD runs this
  // comparison any more (AC1/US-23.16 AC8 removed both gates it used to guard);
  // it survives only for `comment-utils.ts`'s UI-level delete popover gate.
  check('US-23.11 AC9: the same name matches itself',
    sameAuthor('hungvu', 'hungvu'));
  check('US-23.11 AC9: a trailing space in the setting still matches',
    sameAuthor('hungvu ', 'hungvu'));
  check('US-23.11 AC9: case differences still match',
    sameAuthor('HungVu', 'hungvu'));
  check('US-23.11 AC9: NFD and NFC of the same name match',
    sameAuthor('Nguyễn'.normalize('NFD'), 'Nguyễn'.normalize('NFC')));
  check('US-23.11 AC9: a percent-encoded name matches its decoded form',
    sameAuthor('nguy%E1%BB%85n', 'nguyễn'));
  check('US-23.11 AC9: a malformed percent escape falls back to the literal text',
    sameAuthor('100%', '100%'));
  check('US-23.11 AC9: an unconfigured (empty) name matches no real author',
    !sameAuthor('', 'hungvu') && !sameAuthor('hungvu', ''));
  // AC9's "an empty authorName never matches any stored author" is scoped to the
  // CURRENT USER's name, and `resolveCommentAuthor` is what enforces it: a blank
  // setting is replaced by the OS username before it is ever compared, so the
  // blank identity never reaches `sameAuthor` from the live path at all.
  check('US-23.11 AC9: a blank configured name never becomes an identity',
    resolveCommentAuthor('', 'os-user') === 'os-user' &&
      resolveCommentAuthor('   ', 'os-user') === 'os-user');
  // Two blank STORED authors still compare equal on purpose: the loader's
  // tombstone check compares two recorded names, and refusing that match would
  // stop a `delete` line from deleting its target — resurrecting, on the next
  // load, a comment the user had removed.
  check('US-23.11 AC9: two blank stored authors still match, so a tombstone still applies',
    sameAuthor('', '') && sameAuthor('   ', ''));
  // Case-folding can itself denormalize (İ U+0130 lowercases to `i` + a combining
  // dot), so the normalizer re-normalizes afterwards — without that, the NFD and
  // NFC spellings of such a name compare unequal.
  check('US-23.11 AC9: a name whose case-folding denormalizes still matches its NFD form',
    sameAuthor('İlker', 'İlker'.normalize('NFD')));
  check('US-23.11 AC9: different names still do not match',
    !sameAuthor('hungvu', 'mai.tran'));
  // A stray delete from a race between two sessions must not error the load.
  // Distinct ids: three independent stray deletes, not the same line repeated
  // (a shared default id would be caught by AC1's cross-type dedup instead).
  const strayDelete = foldSidecarRecords([
    comment(),
    tombstone({ id: 'd1', target_id: 'nope' }),
    tombstone({ id: 'd2', target_id: 'also-nope' }),
    tombstone({ id: 'd3', target_id: 'still-nope' }),
  ]);
  check('sidecar: a delete naming an unknown target is a silent no-op',
    strayDelete.threads.length === 1 && strayDelete.warnings.length === 0);
  check('sidecar: a delete naming an unknown target routes to orphans (AC7)',
    strayDelete.orphans.length === 3);

  // Regression (review 2026-07-26): duplicate ids were deduped for `comment` only.
  // A merge that lands one reply twice displayed it twice — and since
  // `deletedReplies` is keyed by id, ONE tombstone removed BOTH copies even when
  // their authors differed.
  const dupReply = foldSidecarRecords([comment(), reply({ body: 'one' }), reply({ body: 'two' })]);
  check('sidecar: a duplicate reply id keeps the first-seen line',
    dupReply.threads[0].replies.length === 1 && dupReply.threads[0].replies[0].body === 'one');
  check('sidecar: a duplicate reply id is flagged', dupReply.warnings.length === 1);
  check('sidecar: a duplicate status-change id keeps the first-seen line',
    foldSidecarRecords([comment(), statusChange(), statusChange({ to_status: 'Closed' })]).threads[0].status === 'Resolved');
  // AC8: no authority check — the surviving (first-seen) duplicate is
  // deletable by any author, not just its own.
  check('sidecar: a duplicate reply id\'s surviving copy is deletable by any author (AC8)',
    foldSidecarRecords([
      comment(),
      reply({ author: 'A', body: "A's" }),
      reply({ author: 'B', body: "B's" }),
      tombstone({ author: 'B' }),
    ]).threads[0].replies.length === 0);

  // AC1/AC2: dedup applies ACROSS types too, not just within one — a `reply`
  // and a `status-change` sharing one `id` (a pathological merge/cherry-pick)
  // resolve by the same lowest-timestamp rule, regardless of type. The reply's
  // earlier timestamp wins, so the status-change never applies.
  const crossTypeDup = foldSidecarRecords([
    comment(),
    reply({ id: 'x1', timestamp: '2026-07-26T09:00:00.000Z', body: 'reply wins (earlier timestamp)' }),
    statusChange({ id: 'x1', timestamp: '2026-07-26T10:00:00.000Z' }),
  ]);
  check('sidecar: a cross-type id collision keeps the lowest-timestamp line regardless of type',
    crossTypeDup.threads[0].replies.length === 1 &&
      crossTypeDup.threads[0].replies[0].body === 'reply wins (earlier timestamp)' &&
      crossTypeDup.threads[0].status === 'Open');
  check('sidecar: a cross-type id collision is flagged',
    crossTypeDup.warnings.some((w) => w.includes('x1')));
  // An unparseable timestamp is treated as the oldest possible value in a
  // dedup tie too (AC2), same rule `byTimestamp` already applies to ordering.
  const garbageTimestampDup = foldSidecarRecords([
    comment({ body: 'has a real timestamp' }),
    reply({ id: 'r9', timestamp: 'not-a-date', body: 'garbage timestamp — treated as oldest, wins the tie' }),
    reply({ id: 'r9', timestamp: '2026-07-26T11:00:00.000Z', body: 'real timestamp — loses to the garbage one' }),
  ]);
  check('sidecar: an unparseable timestamp wins a dedup tie as the oldest value',
    garbageTimestampDup.threads[0].replies[0].body === 'garbage timestamp — treated as oldest, wins the tie');
  // `delete` lines dedup by id too (previously the only type with none at all).
  const dupDelete = foldSidecarRecords([
    comment(),
    reply(),
    reply({ id: 'r2' }),
    tombstone({ id: 'dup', target_id: 'r1', timestamp: '2026-07-26T13:00:00.000Z' }),
    tombstone({ id: 'dup', target_id: 'r2', timestamp: '2026-07-26T14:00:00.000Z' }),
  ]);
  check('sidecar: a duplicate delete id keeps only the first-seen line\'s effect',
    dupDelete.threads[0].replies.length === 1 && dupDelete.threads[0].replies[0].id === 'r2');

  // Req 24 US-23.13 AC1/AC2: `anchor-update` persists a re-attached or
  // auto-resolved anchor. Its fold is the one line type that resolves
  // last-one-wins by FILE/APPEND order, never by `timestamp` (a fast retry or a
  // clock with coarse resolution must never decide the winner).
  const anchorUpdate = (over: Partial<AnchorUpdateLine> = {}): AnchorUpdateLine => ({
    ...buildAnchorUpdateLine({
      id: 'u1',
      parentCommentId: 'c1',
      author: 'author',
      timestamp: '2026-07-28T10:00:00.000Z',
      origin: 'manual',
      anchor: { offset_start: 0, offset_end: 0, recorded_text: 'moved here', last_known_line: 5, nearest_heading: '' },
    }),
    ...over,
  });
  check('sidecar: with no anchor-update line, a thread keeps its creation-time anchor',
    foldSidecarRecords([comment()]).threads[0].anchor === anchor);
  check('sidecar: a single anchor-update replaces the thread\'s anchor',
    foldSidecarRecords([comment(), anchorUpdate()]).threads[0].anchor.recorded_text === 'moved here');
  check('sidecar: anchor-update last-one-wins resolves by FILE order, not timestamp',
    foldSidecarRecords([
      comment(),
      anchorUpdate({ id: 'u1', timestamp: '2026-07-28T11:00:00.000Z', anchor: { ...anchorUpdate().anchor, recorded_text: 'first-in-file-later-timestamp' } }),
      anchorUpdate({ id: 'u2', timestamp: '2026-07-28T09:00:00.000Z', anchor: { ...anchorUpdate().anchor, recorded_text: 'second-in-file-earlier-timestamp' } }),
    ]).threads[0].anchor.recorded_text === 'second-in-file-earlier-timestamp');
  check('sidecar: a manual re-attach followed by an automatic resolve — the later one (in file order) wins regardless of origin',
    foldSidecarRecords([
      comment(),
      anchorUpdate({ id: 'u1', origin: 'manual', anchor: { ...anchorUpdate().anchor, recorded_text: 'manual' } }),
      anchorUpdate({ id: 'u2', origin: 'resolved', anchor: { ...anchorUpdate().anchor, recorded_text: 'resolved' } }),
    ]).threads[0].anchor.recorded_text === 'resolved');
  check('sidecar: a duplicate anchor-update id keeps the first-seen line',
    foldSidecarRecords([
      comment(),
      anchorUpdate({ anchor: { ...anchorUpdate().anchor, recorded_text: 'first' } }),
      anchorUpdate({ anchor: { ...anchorUpdate().anchor, recorded_text: 'second' } }),
    ]).threads[0].anchor.recorded_text === 'first');
  check('sidecar: a duplicate anchor-update id is flagged',
    foldSidecarRecords([comment(), anchorUpdate(), anchorUpdate()]).warnings.length === 1);
  // AC7: unlike reply/status-change, an anchor-update whose parent doesn't
  // resolve used to be a silent no-op — now it routes to orphans like every
  // other line type.
  check('sidecar: an anchor-update with no parent routes to orphans',
    foldSidecarRecords([comment(), anchorUpdate({ parent_comment_id: 'missing' })]).orphans.length === 1);
  // Review finding (2026-07-28): a dedup winner that is NOT its id's
  // first on-disk occurrence must still take its OWN true on-disk position in
  // the deduped stream — not the position of that id's first occurrence —
  // or `anchor-update`'s last-one-wins fold can pick the wrong line. Here
  // 'a1' wins dedup (lower timestamp) despite being appended LAST, after 'a2'.
  const orderInversion = foldSidecarRecords([
    comment(),
    anchorUpdate({ id: 'a1', timestamp: '2026-07-28T09:00:00.000Z', anchor: { ...anchorUpdate().anchor, recorded_text: 'first-occurrence-of-a1' } }),
    anchorUpdate({ id: 'a2', timestamp: '2026-07-28T10:00:00.000Z', anchor: { ...anchorUpdate().anchor, recorded_text: 'a2-appended-between' } }),
    anchorUpdate({ id: 'a1', timestamp: '2026-07-28T05:00:00.000Z', anchor: { ...anchorUpdate().anchor, recorded_text: 'a1-wins-dedup-appended-last' } }),
  ]);
  check('sidecar: a dedup winner takes its own true on-disk position, not its id\'s first-occurrence position',
    orderInversion.threads[0].anchor.recorded_text === 'a1-wins-dedup-appended-last');

  // US-23.14: an append-only correction of a comment/reply's `body`, mirroring
  // `delete`'s tombstone pattern — but UNLIKE anchor-update's pure file-order
  // fold, AC3 says the LATEST TIMESTAMP wins, tie broken by file/append order.
  const editLine = (over: Partial<EditLine> = {}): EditLine => ({
    ...buildEditLine({
      id: 'e1',
      targetId: 'c1',
      author: 'author',
      timestamp: '2026-07-28T16:00:00.000Z',
      body: 'edited body',
    }),
    ...over,
  });
  check('sidecar: with no edit line, a thread keeps its original comment body',
    foldSidecarRecords([comment()]).threads[0].comment.body === 'why?');
  check('sidecar: with no edit line, editedAt is never set',
    foldSidecarRecords([comment()]).threads[0].comment.editedAt === undefined);
  check('sidecar: a single edit line replaces the comment\'s displayed body',
    foldSidecarRecords([comment(), editLine()]).threads[0].comment.body === 'edited body');
  check('sidecar: a folded edit sets editedAt to the winning edit\'s own timestamp',
    foldSidecarRecords([comment(), editLine()]).threads[0].comment.editedAt === '2026-07-28T16:00:00.000Z');
  check('sidecar: the original author/timestamp survive an edit unchanged',
    foldSidecarRecords([comment(), editLine()]).threads[0].comment.author === 'reviewer' &&
      foldSidecarRecords([comment(), editLine()]).threads[0].comment.timestamp === '2026-07-26T10:00:00.000Z');
  check('sidecar: an edit line can also target a reply',
    foldSidecarRecords([comment(), reply(), editLine({ id: 'e2', target_id: 'r1', body: 'fixed the typo' })])
      .threads[0].replies[0].body === 'fixed the typo');
  // AC3: latest TIMESTAMP wins — the opposite primary rule from anchor-update's
  // pure file-order fold.
  check('sidecar: edit fold — the LATER timestamp wins regardless of file order',
    foldSidecarRecords([
      comment(),
      editLine({ id: 'e1', timestamp: '2026-07-28T18:00:00.000Z', body: 'first-in-file-later-timestamp' }),
      editLine({ id: 'e2', timestamp: '2026-07-28T09:00:00.000Z', body: 'second-in-file-earlier-timestamp' }),
    ]).threads[0].comment.body === 'first-in-file-later-timestamp');
  // AC3 sub: an exact timestamp tie resolves by file/append order.
  check('sidecar: edit fold — an exact timestamp tie resolves by file/append order',
    foldSidecarRecords([
      comment(),
      editLine({ id: 'e1', timestamp: '2026-07-28T16:00:00.000Z', body: 'first-in-file' }),
      editLine({ id: 'e2', timestamp: '2026-07-28T16:00:00.000Z', body: 'second-in-file' }),
    ]).threads[0].comment.body === 'second-in-file');
  // AC5: idempotent no-op on an unknown or already-tombstoned target — the
  // same tolerance `delete` already has.
  check('sidecar: an edit naming an unknown target_id is an idempotent no-op',
    foldSidecarRecords([comment(), editLine({ target_id: 'no-such-id' })]).threads[0].comment.body === 'why?');
  check('sidecar: an edit naming an unknown target does not warn or error',
    foldSidecarRecords([comment(), editLine({ target_id: 'no-such-id' })]).warnings.length === 0);
  // AC7: an unresolvable target now routes to orphans instead of vanishing —
  // an already-tombstoned target still resolves (the maps aren't pruned by
  // deletion), so that ordinary race stays a quiet no-op, untouched below.
  check('sidecar: an edit naming an unknown target routes to orphans',
    foldSidecarRecords([comment(), editLine({ target_id: 'no-such-id' })]).orphans.length === 1);
  check('sidecar: an edit naming a tombstoned target is a no-op, load does not error',
    foldSidecarRecords([comment(), tombstone({ target_id: 'c1', author: 'reviewer' }), editLine()]).threads.length === 0);
  check('sidecar: an edit naming a tombstoned target is NOT an orphan (ordinary race, not unresolvable)',
    foldSidecarRecords([comment(), tombstone({ target_id: 'c1', author: 'reviewer' }), editLine()]).orphans.length === 0);
  // Review finding (2026-07-28): a delete/edit whose target is ITSELF an
  // orphaned reply (its own parent doesn't resolve) must not be silently
  // "applied and hidden" — both the orphaned reply and the delete/edit line
  // must surface in `orphans`, never vanish without a trace.
  const deleteTargetsOrphanedReply = foldSidecarRecords([
    reply({ id: 'ghost-reply', parent_comment_id: 'no-such-comment' }),
    tombstone({ target_id: 'ghost-reply' }),
  ]);
  check('sidecar: a delete naming an orphaned reply routes BOTH lines to orphans, neither vanishes',
    deleteTargetsOrphanedReply.orphans.length === 2 &&
      deleteTargetsOrphanedReply.orphans.some((l) => l.type === 'reply' && l.id === 'ghost-reply') &&
      deleteTargetsOrphanedReply.orphans.some((l) => l.type === 'delete' && l.target_id === 'ghost-reply'));
  const editTargetsOrphanedReply = foldSidecarRecords([
    reply({ id: 'ghost-reply', parent_comment_id: 'no-such-comment' }),
    editLine({ target_id: 'ghost-reply' }),
  ]);
  check('sidecar: an edit naming an orphaned reply routes BOTH lines to orphans, neither vanishes',
    editTargetsOrphanedReply.orphans.length === 2 &&
      editTargetsOrphanedReply.orphans.some((l) => l.type === 'reply' && l.id === 'ghost-reply') &&
      editTargetsOrphanedReply.orphans.some((l) => l.type === 'edit' && l.target_id === 'ghost-reply'));
  // AC8: no authority check — any author's edit line is accepted for any target.
  check('sidecar: an edit is accepted regardless of whose name is on it (no authority check)',
    foldSidecarRecords([comment(), editLine({ author: 'someone-else' })]).threads[0].comment.body === 'edited body');
  // Same first-seen-wins defensive pattern every other line type has.
  check('sidecar: a duplicate edit id keeps the first-seen line',
    foldSidecarRecords([comment(), editLine({ body: 'first' }), editLine({ body: 'second' })]).threads[0].comment.body === 'first');
  check('sidecar: a duplicate edit id is flagged',
    foldSidecarRecords([comment(), editLine(), editLine()]).warnings.length === 1);

  // removeSidecarLineCascade: the delete path's physical line-filter, sharing
  // foldSidecarRecords's own cascade scope (825-846) as a filter instead of a
  // fold-time exclude (_bmad-output/quick-dev/inprogress-comment-delete-sidecar-rewrite.md).
  {
    // Thread delete: comment + its replies + status-changes + anchor-updates +
    // every edit line targeting the comment or one of its replies, all removed.
    const threadLines = [
      comment(),
      reply({ id: 'r1' }),
      reply({ id: 'r2' }),
      statusChange(),
      anchorUpdate(),
      editLine({ id: 'e1', target_id: 'c1' }),
      editLine({ id: 'e2', target_id: 'r1' }),
    ];
    const threadRemoved = removeSidecarLineCascade(threadLines, 'c1');
    check('removeSidecarLineCascade: a thread delete removes the comment line',
      threadRemoved.some((l) => l.type === 'comment') === false);
    check('removeSidecarLineCascade: a thread delete removes every reply under it',
      threadRemoved.some((l) => l.type === 'reply') === false);
    check('removeSidecarLineCascade: a thread delete removes its status-change lines',
      threadRemoved.some((l) => l.type === 'status-change') === false);
    check('removeSidecarLineCascade: a thread delete removes its anchor-update lines',
      threadRemoved.some((l) => l.type === 'anchor-update') === false);
    check('removeSidecarLineCascade: a thread delete removes edits targeting the comment or its replies',
      threadRemoved.some((l) => l.type === 'edit') === false);
    check('removeSidecarLineCascade: a thread delete leaves nothing behind for a file with only that thread',
      threadRemoved.length === 0);

    // Reply-only delete: only that reply's own line (+ its own edit lines) is
    // removed — the comment, other replies, status-changes and anchor-updates
    // for the thread all survive untouched.
    const replyOnlyLines = [
      comment(),
      reply({ id: 'r1' }),
      reply({ id: 'r2' }),
      statusChange(),
      anchorUpdate(),
      editLine({ id: 'e1', target_id: 'r1' }),
      editLine({ id: 'e2', target_id: 'r2' }),
    ];
    const replyRemoved = removeSidecarLineCascade(replyOnlyLines, 'r1');
    check('removeSidecarLineCascade: a reply-only delete removes just that reply',
      replyRemoved.some((l) => l.type === 'reply' && l.id === 'r1') === false &&
        replyRemoved.some((l) => l.type === 'reply' && l.id === 'r2'));
    check('removeSidecarLineCascade: a reply-only delete removes only that reply\'s own edit line',
      replyRemoved.some((l) => l.type === 'edit' && l.target_id === 'r1') === false &&
        replyRemoved.some((l) => l.type === 'edit' && l.target_id === 'r2'));
    check('removeSidecarLineCascade: a reply-only delete leaves the comment untouched',
      replyRemoved.some((l) => l.type === 'comment' && l.id === 'c1'));
    check('removeSidecarLineCascade: a reply-only delete leaves the thread\'s status-change/anchor-update lines untouched',
      replyRemoved.some((l) => l.type === 'status-change') && replyRemoved.some((l) => l.type === 'anchor-update'));
    check('removeSidecarLineCascade: a reply-only delete removes exactly one line (the reply) plus its own edit',
      replyRemoved.length === replyOnlyLines.length - 2);

    // Unknown id: no-op, same tolerance foldSidecarRecords already gives a
    // stray/racing delete.
    const untouched = removeSidecarLineCascade(threadLines, 'no-such-id');
    check('removeSidecarLineCascade: an unknown id is a no-op', untouched.length === threadLines.length);

    // Deleting one thread among several must leave every other thread's own
    // lines byte-identical and in original relative order.
    const otherComment = comment({ id: 'c2' });
    const multiThreadLines = [comment(), reply({ id: 'r1' }), otherComment, reply({ id: 'r2', parent_comment_id: 'c2' })];
    const oneOfSeveral = removeSidecarLineCascade(multiThreadLines, 'c1');
    check('removeSidecarLineCascade: deleting one thread among several leaves the other thread\'s lines untouched and in order',
      oneOfSeveral.length === 2 && oneOfSeveral[0] === otherComment &&
        oneOfSeveral[1].type === 'reply' && oneOfSeveral[1].id === 'r2');
  }

  // pruneDeadSidecarLines: Patch 2 (inprogress-comment-delete-sidecar-rewrite.md)
  // — legacy-GC pass run alongside removeComment's own target-cascade, so a
  // file with pre-existing tombstone bloat (from before this feature shipped,
  // or from an older extension version) shrinks on the next unrelated delete
  // instead of carrying that bloat forever.
  {
    // A legacy tombstone + its already-dead comment/reply/status/anchor/edit
    // lines, alongside one UNRELATED live thread that a delete on it must
    // leave untouched.
    const legacyDeadThread = [
      comment({ id: 'dead-c' }),
      reply({ id: 'dead-r', parent_comment_id: 'dead-c' }),
      statusChange({ id: 'dead-s', parent_comment_id: 'dead-c' }),
      anchorUpdate({ id: 'dead-a', parent_comment_id: 'dead-c' }),
      editLine({ id: 'dead-e', target_id: 'dead-c' }),
      tombstone({ id: 'legacy-tombstone', target_id: 'dead-c' }),
    ];
    const liveThread = [comment({ id: 'live-c' }), reply({ id: 'live-r', parent_comment_id: 'live-c' })];
    const withLegacyBloat = [...legacyDeadThread, ...liveThread];
    const pruned = pruneDeadSidecarLines(withLegacyBloat);
    check('pruneDeadSidecarLines: strips a legacy tombstone-comment pair and its whole cascade',
      pruned.every((l) => !('id' in l) || !l.id.startsWith('dead-')));
    check('pruneDeadSidecarLines: drops the delete-type tombstone line itself',
      pruned.some((l) => l.type === 'delete') === false);
    check('pruneDeadSidecarLines: leaves the unrelated live thread untouched',
      pruned.some((l) => l.type === 'comment' && l.id === 'live-c') &&
        pruned.some((l) => l.type === 'reply' && l.id === 'live-r'));

    // A reply-only legacy tombstone: only that reply (+ its own edit) is dead;
    // the comment and the reply's siblings survive.
    const legacyReplyDelete = [
      comment({ id: 'c1' }),
      reply({ id: 'dead-reply', parent_comment_id: 'c1' }),
      reply({ id: 'r2', parent_comment_id: 'c1' }),
      editLine({ id: 'dead-reply-edit', target_id: 'dead-reply' }),
      tombstone({ id: 'legacy-tombstone-2', target_id: 'dead-reply' }),
    ];
    const prunedReply = pruneDeadSidecarLines(legacyReplyDelete);
    check('pruneDeadSidecarLines: a legacy reply-only tombstone removes just that reply and its edit',
      prunedReply.some((l) => l.type === 'reply' && l.id === 'dead-reply') === false &&
        prunedReply.some((l) => l.type === 'edit' && l.target_id === 'dead-reply') === false &&
        prunedReply.some((l) => l.type === 'comment' && l.id === 'c1') &&
        prunedReply.some((l) => l.type === 'reply' && l.id === 'r2'));

    // A tombstone naming an orphaned reply (parent never existed) is a genuine
    // orphan, not dead weight — foldSidecarRecords already preserves it in
    // `orphans`; this pass must not silently delete the orphan reply itself
    // (only the now-pointless tombstone line, per (a), is dropped).
    const orphanReplyLines = [reply({ id: 'ghost-reply', parent_comment_id: 'no-such-comment' })];
    const prunedOrphan = pruneDeadSidecarLines(orphanReplyLines);
    check('pruneDeadSidecarLines: an orphaned reply (parent never existed) is preserved, not GC\'d',
      prunedOrphan.some((l) => l.type === 'reply' && l.id === 'ghost-reply'));

    // A file with no legacy dead weight at all is returned unchanged (minus
    // any delete-type lines, of which there are none here).
    const cleanFile = [comment({ id: 'clean-c' }), reply({ id: 'clean-r', parent_comment_id: 'clean-c' })];
    check('pruneDeadSidecarLines: a file with nothing dead is left as-is',
      pruneDeadSidecarLines(cleanFile).length === cleanFile.length);
  }

  // AC7 clause 2 / US-23.16 AC4-AC6: does this sidecar even describe the
  // document it sits next to? Decided by CONTENT, never by the file's
  // creation date — `git clone`/`git checkout` recreate the file so its birth
  // time becomes "now" while its comments stay older, which would discard
  // every comment after any fresh clone.
  {
    const withText = (text: string, id: string): SidecarThread =>
      foldSidecarRecords([comment({ id, anchor: { ...anchor, recorded_text: text } })]).threads[0];
    const realDoc =
      '# Requirement 23\n\nThis is **bold** text in a paragraph about requirement twenty three details right here.\n\n' +
      'See the specification document for full acceptance criteria details.\n\n' +
      'This is bold text in a paragraph today for sure.\n\nSee [the spec](a.md).\n';
    const foreignDoc = '# Sprint retro notes\n\nWhat went well this iteration.\n';
    // >= BELONGING_SINGLE_THREAD_MIN_CHARS (80) normalized chars, present in realDoc.
    const single80 = 'This is bold text in a paragraph about requirement twenty three details right here';
    // >= BELONGING_MIN_DISCRIMINATING_CHARS (40) normalized chars each, both present in realDoc.
    const discA = 'This is bold text in a paragraph today for sure.';
    const discB = 'See the specification document for full acceptance criteria details.';
    // >= 40 normalized chars each, present in NEITHER doc — real evidence, just the wrong one.
    const foreignLong1 = 'Sprint retro notes about what went well and what needs improvement this whole cycle';
    const foreignLong2 = 'Retro notes covering what went well and what could improve next sprint cycle';
    // < BELONGING_MIN_DISCRIMINATING_CHARS (40) normalized chars — a "Done"/"N/A"-style short match.
    const discShort = 'nothing like this here at all';

    // --- Single-thread case: the stricter 80-char floor (AC5) ---
    check('belonging (single thread): a match clearing the 80-char floor proves belonging',
      sidecarBelongsToDocument([withText(single80, 'c1')], realDoc) === 'belongs');
    check('belonging (single thread): a below-80-char match is not discriminating enough on its own',
      sidecarBelongsToDocument([withText(discA, 'c1')], realDoc) === 'unknown');
    check('belonging (single thread): a floor-clearing text absent from the document is foreign',
      sidecarBelongsToDocument([withText(single80, 'c1')], foreignDoc) === 'foreign');
    check('belonging: no threads at all yields no claim',
      sidecarBelongsToDocument([], foreignDoc) === 'unknown');

    // --- Multi-thread case: the 40-char floor, needs MORE THAN ONE match (AC5/AC6) ---
    check('belonging (multi-thread): more than one discriminating match proves belonging',
      sidecarBelongsToDocument([withText(discA, 'c1'), withText(discB, 'c2')], realDoc) === 'belongs');
    // Exactly one hit is real evidence, but it is also exactly the
    // boilerplate-recreated-file case AC5 guards against — not proof, and not
    // evidence against belonging either, so `unknown`, never `foreign`.
    check('belonging (multi-thread): exactly one discriminating match is not enough to prove belonging',
      sidecarBelongsToDocument([withText(discA, 'c1'), withText(discShort, 'c2')], realDoc) === 'unknown');
    check('belonging (multi-thread): threads below the floor contribute no evidence either way',
      sidecarBelongsToDocument([withText(discShort, 'c1'), withText('Done', 'c2')], foreignDoc) === 'unknown');
    check('belonging (multi-thread): zero discriminating matches is foreign',
      sidecarBelongsToDocument([withText(foreignLong1, 'c1'), withText(foreignLong2, 'c2')], realDoc) === 'foreign');
    // AC6: a partial rewrite (one section's anchors no longer match) is judged
    // by the SAME discriminating-match-count rule, not a separate signal — as
    // long as more than one thread still matches, the sidecar still belongs.
    check('belonging (AC6, partial rewrite): >1 surviving match still proves belonging alongside a non-matching third thread',
      sidecarBelongsToDocument(
        [withText(discA, 'c1'), withText(discB, 'c2'), withText(foreignLong1, 'c3')],
        realDoc
      ) === 'belongs');
    // Review finding (2026-07-28): two threads recording the IDENTICAL
    // discriminating text (this repo's own template boilerplate, repeated
    // verbatim across sections) must count as ONE piece of evidence, not
    // two — else a single repeated phrase defeats the "more than one match"
    // guard AC5 exists to enforce.
    const identicalBoilerplate = 'Acceptance criteria template phrase repeated across every section of this file';
    check('belonging (multi-thread): identical text recorded by two threads counts as ONE match, not two',
      sidecarBelongsToDocument(
        [withText(identicalBoilerplate, 'c1'), withText(identicalBoilerplate, 'c2')],
        realDoc + identicalBoilerplate + '\n'
      ) === 'unknown');

    check('belonging: NFD-authored recorded text still matches an NFC document',
      sidecarBelongsToDocument(
        [withText('Yêu cầu nghiệp vụ chi tiết cho hệ thống quản lý bình luận và thảo luận nhóm dự án'.normalize('NFD'), 'c7')],
        '## Yêu cầu nghiệp vụ chi tiết cho hệ thống quản lý bình luận và thảo luận nhóm dự án'.normalize('NFC')
      ) === 'belongs');

    // Regression (2026-07-29): recorded_text is the DOM's rendered text — a
    // markdown link renders (and is recorded) as just its label, never its
    // target. A still-present anchored paragraph must not turn 'foreign'
    // merely because one of its plain mentions became a link to its own
    // heading; the target's slug words must not split the match.
    const linkLabel = 'a comment about this whole entire paragraph and its very own Bug Number One right here today';
    const linkDoc =
      '# doc\n\nThis is a comment about this whole entire paragraph and its very own [Bug Number One]' +
      '(#bug-number-one--a-long-heading-slug-with-many-extra-words-in-it) right here today.\n';
    check('belonging (single thread): a link-wrapped mention inside the anchored text still matches',
      sidecarBelongsToDocument([withText(linkLabel, 'c8')], linkDoc) === 'belongs');
  }

  // US-23.16 AC7: the orphan-row pill label for each of the 5 orphanable line kinds.
  check('orphanKindLabel: reply', orphanKindLabel('reply') === 'Reply');
  check('orphanKindLabel: status-change', orphanKindLabel('status-change') === 'Status');
  check('orphanKindLabel: anchor-update', orphanKindLabel('anchor-update') === 'Anchor');
  check('orphanKindLabel: delete', orphanKindLabel('delete') === 'Delete');
  check('orphanKindLabel: edit', orphanKindLabel('edit') === 'Edit');

  // Regression (review 2026-07-26): an unparseable timestamp sorted LAST, so one
  // malformed field outranked every valid one and froze a thread's status.
  check('sidecar: a garbage timestamp cannot outrank a real later transition',
    foldSidecarRecords([
      comment(),
      statusChange({ id: 's1', timestamp: 'soon', to_status: 'Closed' }),
      statusChange({ id: 's2', timestamp: '2026-07-26T12:00:00.000Z', from_status: 'Closed', to_status: 'Open' }),
    ]).threads[0].status === 'Open');

  // AC5: name drift a rename event never reports. Never a raw `===` — decode →
  // NFC → separator → optional case-fold (CLAUDE.md's cross-platform trap).
  const nfcName = sidecarNameFor('Yêu cầu.md'.normalize('NFC'));
  const nfdName = sidecarNameFor('Yêu cầu.md'.normalize('NFD'));
  check('sidecar drift: the NFD and NFC names are genuinely different strings', nfcName !== nfdName);
  check('sidecar drift: NFD and NFC names match', sidecarNameMatches(nfdName, nfcName, false));
  check('sidecar drift: case drift matches on a case-insensitive FS',
    sidecarNameMatches(sidecarNameFor('Foo.md'), sidecarNameFor('foo.md'), true));
  check('sidecar drift: case drift does NOT match on a case-sensitive FS',
    sidecarNameMatches(sidecarNameFor('Foo.md'), sidecarNameFor('foo.md'), false) === false);
  // Regression (review 2026-07-26, 3/3 reviewers): the comparison must NOT
  // percent-decode. `a%20b.md` is a legal on-disk name, and an adopt is a
  // destructive rename — so conflating it with `a b.md` would let opening one file
  // steal the other's whole comment history. Mirrors normalizeAssetName's own rule.
  check('sidecar drift: a percent-encoded name is NOT the same file as its decoded form',
    sidecarNameMatches('a%20b.md.orca-comments.jsonl', 'a b.md.orca-comments.jsonl', false) === false);
  check('sidecar drift: a literal % that is not an escape still compares',
    sidecarNameMatches('100%.md.orca-comments.jsonl', '100%.md.orca-comments.jsonl', false));
  check('sidecar drift: the shared on-disk normalizer backs the comparison',
    sidecarNameMatches('Yêu.md.orca-comments.jsonl'.normalize('NFD'), 'Yêu.md.orca-comments.jsonl'.normalize('NFC'), false)
      && normalizeAssetName('Yêu.md'.normalize('NFD')) === normalizeAssetName('Yêu.md'.normalize('NFC')));
  // The paired-.md name is what lets adoptDrifted require an ORPHANED candidate.
  check('sidecar drift: the paired .md name is recoverable',
    mdNameForSidecar('foo.md.orca-comments.jsonl') === 'foo.md');
  check('sidecar drift: a non-sidecar has no paired .md name',
    mdNameForSidecar('foo.md') === null);
  check('sidecar drift: two unrelated names never match',
    sidecarNameMatches(sidecarNameFor('a.md'), sidecarNameFor('b.md'), true) === false);
  // The directory scan must only ever consider real sidecars.
  check('sidecar drift: a sidecar is recognised', isSidecarName('foo.md.orca-comments.jsonl'));
  check('sidecar drift: the paired .md is not a sidecar', isSidecarName('foo.md') === false);
  check('sidecar drift: an unrelated jsonl is not a sidecar', isSidecarName('data.jsonl') === false);
}

// --- Req 24 US-23.12: "Copy all as Markdown" serializer ---------------------
{
  eq('copy-markdown: timestamp format, +07:00 offset', formatExportTimestamp('2026-07-26T06:42:00.000Z', 420),
    '2026-07-26 13:42 +07:00');
  eq('copy-markdown: timestamp format, negative offset', formatExportTimestamp('2026-07-26T06:42:00.000Z', -300),
    '2026-07-26 01:42 -05:00');
  eq('copy-markdown: timestamp format, UTC (zero offset)', formatExportTimestamp('2026-07-26T06:42:00.000Z', 0),
    '2026-07-26 06:42 +00:00');
  check('copy-markdown: an unparseable timestamp is returned as-is, never "Invalid Date"',
    formatExportTimestamp('not-a-date', 0) === 'not-a-date');

  eq('copy-markdown: escapes the CommonMark punctuation set', escapeMarkdownInline('a *b* _c_ [d](e) <f> `g` h|i ~j# k'),
    'a \\*b\\* \\_c\\_ \\[d\\](e) \\<f\\> \\`g\\` h\\|i \\~j\\# k');
  eq('copy-markdown: escapes a leading dash list marker', escapeMarkdownInline('- looks like a list item'),
    '\\- looks like a list item');
  eq('copy-markdown: escapes a leading ordered-list marker', escapeMarkdownInline('1. looks ordered'),
    '1\\. looks ordered');
  check('copy-markdown: a mid-string dash is untouched', escapeMarkdownInline('a - b') === 'a - b');

  eq('copy-markdown: snippet collapses whitespace', buildSnippetLine('line one\n  line   two  '), '> line one line two');
  check('copy-markdown: a textless anchor omits the snippet entirely', buildSnippetLine('   ') === undefined);
  {
    const longText = 'x'.repeat(310);
    const snippet = buildSnippetLine(longText);
    check('copy-markdown: snippet is truncated at 300 code points with an ellipsis',
      snippet !== undefined && snippet === `> ${'x'.repeat(300)}…`);
  }
  {
    // Surrogate pair (a non-BMP emoji) landing exactly on the 300-char boundary
    // must never split into a lone surrogate.
    const emoji = '😀'; // 2 UTF-16 code units, 1 code point
    const longText = 'x'.repeat(299) + emoji + 'y'.repeat(10);
    const snippet = buildSnippetLine(longText) ?? '';
    check('copy-markdown: truncation never splits a surrogate pair',
      !/[\uD800-\uDBFF]$/.test(snippet.replace('…', '')) && snippet.includes(emoji));
  }

  const thread = (over: Partial<ExportThread> = {}): ExportThread => ({
    group: 'open',
    status: 'Open',
    location: { kind: 'line', line: 88, approximate: false },
    lastTransitionAuthor: 'hungvu',
    lastTransitionTimestamp: '2026-07-26T06:42:00.000Z',
    anchorText: 'the anchored text, whitespace-collapsed and truncated',
    comments: [{ author: 'hungvu', timestamp: '2026-07-26T06:42:00.000Z', body: 'Why does this contradict US-23.4?' }],
    ...over,
  });

  {
    const snapshot: ExportSnapshot = {
      docRelativePath: 'docs/Requirement - 23.md',
      exportedAtIso: '2026-07-27T07:03:00.000Z',
      foreignSidecar: false,
      threads: [thread()],
    };
    const md = renderCommentsMarkdown(snapshot);
    check('copy-markdown: header names the doc path, thread count and export time',
      md.startsWith('## Review — docs/Requirement - 23.md · 1 thread · '));
    check('copy-markdown: singular "1 thread", not "1 threads"', md.includes('· 1 thread ·'));
    check('copy-markdown: group heading with count', md.includes('### Open (1)'));
    check('copy-markdown: thread heading — status, location, author, timestamp, in order',
      md.includes('#### Open · Ln 88 · hungvu · '));
    check('copy-markdown: blockquoted snippet present for a non-floating, non-textless anchor',
      md.includes('> the anchored text, whitespace-collapsed and truncated'));
    check('copy-markdown: the opening comment is a top-level bullet',
      md.includes('- **hungvu** · ') && md.includes(' — Why does this contradict US-23.4?'));
    check('copy-markdown: ends with a trailing newline, LF only', md.endsWith('\n') && !md.includes('\r'));
  }

  {
    // AC4: two fields never appear — the thread id, and any status-change line
    // other than the last (no "trail").
    const t = thread({
      lastTransitionAuthor: 'otheruser',
      lastTransitionTimestamp: '2026-07-26T07:03:00.000Z',
      comments: [
        { author: 'hungvu', timestamp: '2026-07-26T06:42:00.000Z', body: 'Original comment.' },
        { author: 'otheruser', timestamp: '2026-07-26T07:03:00.000Z', body: 'Fixed, please re-check.' },
      ],
    });
    const md = renderCommentsMarkdown({
      docRelativePath: 'a.md', exportedAtIso: '2026-07-27T07:03:00.000Z', foreignSidecar: false, threads: [t],
    });
    check('copy-markdown: a reply is indented under the opening comment',
      md.includes('  - **otheruser** · ') && md.includes(' — Fixed, please re-check.'));
    check('copy-markdown: no thread id anywhere in the output (AC4 exclusion)', !/\bthreadId\b|\bid:\s*['"]/.test(md));
  }

  {
    // AC4: a floating thread — no blockquote, its own location wording, status kept independent of "floating".
    const t = thread({ group: 'floating', status: 'Resolved', location: { kind: 'floating' }, anchorText: 'unused' });
    const md = renderCommentsMarkdown({
      docRelativePath: 'a.md', exportedAtIso: '2026-07-27T07:03:00.000Z', foreignSidecar: false, threads: [t],
    });
    check('copy-markdown: floating group label is "Unresolved location"', md.includes('### Unresolved location (1)'));
    check('copy-markdown: floating thread heading reads "No anchor — Unresolved location", status kept',
      md.includes('#### Resolved · No anchor — Unresolved location · '));
    check('copy-markdown: no blockquote line for a floating thread', !md.includes('> unused'));
  }

  {
    // AC4: whole-document and approximate-range locations.
    const wholeDoc = thread({ location: { kind: 'wholeDocument', approximate: true } });
    const range = thread({ location: { kind: 'range', start: 12, end: 18, approximate: true } });
    const md = renderCommentsMarkdown({
      docRelativePath: 'a.md', exportedAtIso: '2026-07-27T07:03:00.000Z', foreignSidecar: false,
      threads: [wholeDoc, range],
    });
    check('copy-markdown: whole-document location with approximate marker',
      md.includes('Whole document (approximate)'));
    check('copy-markdown: multi-line range location with approximate marker', md.includes('Ln 12–18 (approximate)'));
  }

  {
    // AC3: empty groups omitted, fixed order Open -> Unresolved -> Resolved -> Closed.
    const md = renderCommentsMarkdown({
      docRelativePath: 'a.md', exportedAtIso: '2026-07-27T07:03:00.000Z', foreignSidecar: false,
      threads: [thread({ group: 'closed', status: 'Closed' }), thread({ group: 'open' })],
    });
    const openIdx = md.indexOf('### Open');
    const closedIdx = md.indexOf('### Closed');
    check('copy-markdown: Open group precedes Closed group', openIdx >= 0 && closedIdx > openIdx);
    check('copy-markdown: no empty group headings for absent groups',
      !md.includes('### Unresolved location') && !md.includes('### Resolved'));
  }

  {
    // AC4: the foreign-sidecar cause line sits directly under the document header.
    const md = renderCommentsMarkdown({
      docRelativePath: 'a.md', exportedAtIso: '2026-07-27T07:03:00.000Z', foreignSidecar: true, threads: [thread()],
    });
    const lines = md.split('\n\n');
    check('copy-markdown: foreign-sidecar banner is the segment right after the header',
      lines[0].startsWith('## Review') && lines[1].includes('may describe a different document'));
  }

  {
    // AC4: an absent/blank author renders the literal "Unknown author".
    const t = thread({
      lastTransitionAuthor: '  ',
      comments: [{ author: '', timestamp: '2026-07-26T06:42:00.000Z', body: 'x' }],
    });
    const md = renderCommentsMarkdown({
      docRelativePath: 'a.md', exportedAtIso: '2026-07-27T07:03:00.000Z', foreignSidecar: false, threads: [t],
    });
    check('copy-markdown: blank thread-heading author renders "Unknown author"', md.includes('· Unknown author ·'));
    check('copy-markdown: blank comment author renders "Unknown author"', md.includes('**Unknown author** · '));
  }

  {
    // AC6: escaping must never alter the export's own structure — same heading
    // and top-level list-item counts whether or not the body/snippet carry
    // Markdown-significant characters.
    const headingCount = (s: string): number => (s.match(/^#{2,4} /gm) ?? []).length;
    const listItemCount = (s: string): number => (s.match(/^-\s|^  - /gm) ?? []).length;
    const plain = thread();
    const hostile = thread({
      anchorText: '# not a heading\n- not a list item',
      comments: [
        // Single-line on purpose — a multi-line body is fenced (verbatim), not
        // escaped; the fenced case is covered by its own test below.
        { author: '*bold* author', timestamp: '2026-07-26T06:42:00.000Z', body: '# fake heading - fake list `code`' },
      ],
    });
    const mdPlain = renderCommentsMarkdown({
      docRelativePath: 'a.md', exportedAtIso: '2026-07-27T07:03:00.000Z', foreignSidecar: false, threads: [plain],
    });
    const mdHostile = renderCommentsMarkdown({
      docRelativePath: 'a.md', exportedAtIso: '2026-07-27T07:03:00.000Z', foreignSidecar: false, threads: [hostile],
    });
    eq('copy-markdown round-trip: heading count unchanged by hostile body/snippet content',
      headingCount(mdHostile), headingCount(mdPlain));
    eq('copy-markdown round-trip: top-level list-item count unchanged by hostile body/snippet content',
      listItemCount(mdHostile), listItemCount(mdPlain));
    check('copy-markdown round-trip: the hostile snippet\'s "#"/"-" survive literally inside the blockquote',
      mdHostile.includes('> # not a heading - not a list item'));
    check('copy-markdown round-trip: the hostile body\'s leading "#" and its backticks are escaped',
      mdHostile.includes('\\# fake heading - fake list \\`code\\`'));
  }

  {
    // AC6: a multi-line body is fenced, never inlined — with a fence longer
    // than any backtick run already inside the body.
    const t = thread({ comments: [{ author: 'hungvu', timestamp: '2026-07-26T06:42:00.000Z', body: 'line one\n\nline two ``` still inside' }] });
    const md = renderCommentsMarkdown({
      docRelativePath: 'a.md', exportedAtIso: '2026-07-27T07:03:00.000Z', foreignSidecar: false, threads: [t],
    });
    check('copy-markdown: multi-line body is wrapped in a fence at least 4 backticks long',
      /````+\n/.test(md));
    check('copy-markdown: the fenced body text is verbatim (not escaped)',
      md.includes('line two ``` still inside'));
  }

  // AC8: the six disabled-reason causes, in priority order.
  const enabledInput = {
    sidecarProblem: undefined, loading: false, sidecarForeign: false,
    totalThreadCount: 3, exportableThreadCount: 3, hideClosed: false,
  };
  check('copy-disabled: nothing disables an ordinary exportable file',
    copyDisabledReason(enabledInput) === undefined);
  check('copy-disabled: a sidecar problem always wins first',
    copyDisabledReason({ ...enabledInput, sidecarProblem: 'The comment sidecar could not be read.' })
      === 'The comment sidecar could not be read.');
  check('copy-disabled: loading beats an empty-looking thread list',
    copyDisabledReason({ ...enabledInput, loading: true, totalThreadCount: 0, exportableThreadCount: 0 }) !== undefined);
  check('copy-disabled: foreign sidecar with zero threads names that cause',
    (copyDisabledReason({ ...enabledInput, sidecarForeign: true, totalThreadCount: 0, exportableThreadCount: 0 }) ?? '')
      .includes('may describe a different document'));
  check('copy-disabled: foreign sidecar with real threads present does NOT disable',
    copyDisabledReason({ ...enabledInput, sidecarForeign: true }) === undefined);
  check('copy-disabled: "Hide closed" hiding everything gets its own reason',
    copyDisabledReason({ ...enabledInput, exportableThreadCount: 0, hideClosed: true, totalThreadCount: 3 })
      !== undefined);
  check('copy-disabled: genuinely zero threads gets the generic no-comments reason',
    copyDisabledReason({ ...enabledInput, totalThreadCount: 0, exportableThreadCount: 0 })
      === 'No comments in this file to copy.');

  // AC1: the status-bar confirmation wording (host-side, comment-utils.ts).
  eq('copy-confirmation: singular, no hidden-closed suffix', copyConfirmationMessage(1, undefined),
    'Copied 1 thread as Markdown');
  eq('copy-confirmation: plural', copyConfirmationMessage(9, undefined), 'Copied 9 threads as Markdown');
  eq('copy-confirmation: names the excluded "Hide closed" count', copyConfirmationMessage(9, 3),
    'Copied 9 threads as Markdown (3 Closed hidden)');
  eq('copy-confirmation: a zero hidden-closed count is not named', copyConfirmationMessage(9, 0),
    'Copied 9 threads as Markdown');
}

// --- Req 24 US-23.14: editRejection (the host-side write-path validator) ------
{
  const base: EditCommentMessage = {
    type: 'editComment',
    requestId: 1,
    docUri: 'file:///a.md',
    threadId: 't1',
    body: 'a corrected body',
  };
  const rej = (over: Partial<EditCommentMessage> = {}, status: CommentStatus | undefined = 'Open', original?: string) =>
    editRejection({ ...base, ...over }, 'file:///a.md', status, original);

  check('edit-rejection: a valid edit on an Open thread is accepted', rej() === null);
  check('edit-rejection: a valid edit on a Resolved thread is accepted', rej({}, 'Resolved') === null);
  // AC1's Closed lockout, enforced on the write path (not only in the popover).
  check('edit-rejection: a Closed thread is refused',
    (rej({}, 'Closed') ?? '').includes('closed'));
  // Called directly, not through `rej`: passing `undefined` to a parameter that
  // HAS a default silently gets the default ('Open'), so the helper cannot
  // express "no such thread".
  check('edit-rejection: an unknown thread is refused',
    editRejection(base, 'file:///a.md', undefined) !== null);
  check('edit-rejection: a different document is refused',
    rej({ docUri: 'file:///other.md' }) !== null);
  check('edit-rejection: an empty threadId is refused', rej({ threadId: '' }) !== null);
  // AC7: empty/whitespace-only is what Delete is for.
  check('edit-rejection: an empty body is refused', rej({ body: '' }) !== null);
  check('edit-rejection: a whitespace-only body is refused', rej({ body: '   \n\t ' }) !== null);
  // Untrusted input: a non-string body must be refused, never reach `.trim()`
  // and throw inside the host handler (which would post no result at all).
  check('edit-rejection: a non-string body is refused, not thrown on',
    rej({ body: undefined as unknown as string }) !== null &&
      rej({ body: 42 as unknown as string }) !== null);
  // AC7's cap.
  check('edit-rejection: a body at the cap is accepted',
    rej({ body: 'a'.repeat(COMMENT_BODY_MAX_CODEPOINTS) }) === null);
  check('edit-rejection: a body over the cap is refused',
    rej({ body: 'a'.repeat(COMMENT_BODY_MAX_CODEPOINTS + 1) }) !== null);
  // ...but an ALREADY over-cap body (creation's own cap is unbuilt — US-23.10
  // AC10) must stay editable, and an edit must never be blamed for length it
  // did not introduce. Ceiling = max(cap, original length).
  const overLong = 'a'.repeat(COMMENT_BODY_MAX_CODEPOINTS + 500);
  check('edit-rejection: an already-over-cap body can still be edited at its own length',
    rej({ body: overLong }, 'Open', overLong) === null);
  check('edit-rejection: an already-over-cap body can be edited DOWN',
    rej({ body: 'a'.repeat(100) }, 'Open', overLong) === null);
  check('edit-rejection: an already-over-cap body still cannot be GROWN further',
    rej({ body: 'a'.repeat(COMMENT_BODY_MAX_CODEPOINTS + 501) }, 'Open', overLong) !== null);
  // AC8: no authority check anywhere in this validator — there is no author
  // parameter to gate on, unlike `deleteRejection`.
  check('edit-rejection: takes no author argument at all (AC8 — no authority check)',
    editRejection.length <= 4);
}

// --- Req 23 US-23.10 AC9: the shared body neutralize/EOL helpers -------------
{
  // Moved into `src/comments/comment-body-limit.ts` so the NATIVE write path
  // (US-23.14) gets the identical strip the webview already applied.
  check('body-neutralize: a bidi override (Trojan Source) is stripped',
    neutralizeCommentBody('safe‮evil') === 'safeevil');
  check('body-neutralize: a bidi isolate is stripped',
    neutralizeCommentBody('a⁦b⁩c') === 'abc');
  check('body-neutralize: a C0 control char is stripped', neutralizeCommentBody('ab') === 'ab');
  check('body-neutralize: newline and tab survive (a body is multi-line)',
    neutralizeCommentBody('a\nb\tc') === 'a\nb\tc');
  check('body-eol: CRLF and lone CR both reconcile to LF',
    normalizeCommentBodyEol('a\r\nb\rc') === 'a\nb\nc');
  // The webview's own exports must be the SAME behaviour, not a second copy.
  check('body-neutralize: dom-utils delegates to the shared implementation',
    neutralizeBodyText('x‮y') === neutralizeCommentBody('x‮y') &&
      normalizeBodyEol('x\r\ny') === normalizeCommentBodyEol('x\r\ny'));
}

// --- Req 23 US-23.10 AC10 / Req 24 US-23.14 AC7: comment-body length bound --
{
  check('body-limit: an empty string counts as 0 code points', commentBodyCodePointLength('') === 0);
  check('body-limit: plain ASCII counts one per character', commentBodyCodePointLength('hello') === 5);
  // Code-point-safe: an astral character (surrogate pair in UTF-16) counts as 1.
  check('body-limit: a surrogate-pair (astral) character counts as ONE code point',
    commentBodyCodePointLength('😀') === 1 && '😀'.length === 2);
  check('body-limit: text under the cap is returned unchanged',
    clipCommentBodyToLimit('short text') === 'short text');
  const exact = 'a'.repeat(COMMENT_BODY_MAX_CODEPOINTS);
  check('body-limit: text exactly at the cap is unchanged', clipCommentBodyToLimit(exact) === exact);
  const over = 'a'.repeat(COMMENT_BODY_MAX_CODEPOINTS + 50);
  const clipped = clipCommentBodyToLimit(over);
  check('body-limit: text over the cap is clipped to exactly the cap',
    commentBodyCodePointLength(clipped) === COMMENT_BODY_MAX_CODEPOINTS);
  // Never split a surrogate pair mid-character when clipping at the boundary.
  const astralOver = `${'a'.repeat(COMMENT_BODY_MAX_CODEPOINTS - 1)}😀EXTRA`;
  const astralClipped = clipCommentBodyToLimit(astralOver);
  check('body-limit: clipping never splits a surrogate pair',
    commentBodyCodePointLength(astralClipped) === COMMENT_BODY_MAX_CODEPOINTS &&
      astralClipped.endsWith('😀'));
  check('body-limit: the counter threshold sits below the hard cap',
    COMMENT_BODY_COUNTER_THRESHOLD < COMMENT_BODY_MAX_CODEPOINTS);
}

// --- Req 24 US-23.22: an unregistered #content class fails `npm test` --------
//
// Source-scanning check, same shape (and same `process.cwd()` convention) as
// the `src/provider.ts` security tripwire above. The scan itself and the two
// exemption arrays live in `test/transient-class-scan.ts`; this block is the
// gate that runs it against the real tree, plus positive controls proving the
// scan is not silently vacuous.
{
  const WEBVIEW_DIR = path.join(process.cwd(), 'media/webview');
  // Recursive: a module moved into a subdirectory must not fall out of the scan
  // without anything saying so.
  const webviewFiles: SourceFile[] = fs
    .readdirSync(WEBVIEW_DIR, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({
      file: name,
      source: fs.readFileSync(path.join(WEBVIEW_DIR, name), 'utf8'),
    }));
  const scopes = collectClassConstants(webviewFiles);
  const sourceOf = (name: string): string =>
    webviewFiles.find((f) => f.file === name)?.source ?? '';

  // A floor, so a botched glob or a relocated directory reports itself instead
  // of yielding a triumphantly empty scan. The tree held 62 modules when this
  // landed; the floor is deliberately loose — it guards against collapse, not
  // against ordinary deletion.
  check(
    'transient-classes: the scan actually reached the webview modules',
    webviewFiles.length >= 50,
    `  files scanned = ${webviewFiles.length}`
  );

  const identifiers = readTransientClassIdentifiers(sourceOf('turndown.ts'));
  const turndownScope = scopes.get('turndown.ts') ?? new Map<string, string>();
  const registered = new Set<string>();
  const unresolvedIdentifiers: string[] = [];
  for (const id of identifiers) {
    const value = turndownScope.get(id);
    if (value === undefined) {
      unresolvedIdentifiers.push(id);
    } else {
      registered.add(value);
    }
  }

  check(
    'transient-classes: every TRANSIENT_CLASSES entry resolves to a class name',
    identifiers.length > 0 && unresolvedIdentifiers.length === 0,
    `  entries = ${identifiers.length}, unresolved = ${JSON.stringify(unresolvedIdentifiers)}`
  );

  // A file that declares one identifier twice with different values makes every
  // resolution in it a coin flip, so refuse to resolve rather than guess.
  const ambiguous = findAmbiguousConstants(webviewFiles);
  check(
    'transient-classes: no file declares one class constant twice with different values',
    ambiguous.length === 0,
    `  ambiguous: ${JSON.stringify(ambiguous)}`
  );

  // AC2 — one declaration site: every registered name is an EXPORTED constant in
  // constants.ts, holding the same value the strip list resolved. Matching the
  // identifier alone would pass a `FOO_CLASS` imported from elsewhere while
  // constants.ts happens to declare a different `FOO_CLASS`.
  const constantsExported = exportedConstants(sourceOf('constants.ts'));
  const notInConstants = identifiers.filter(
    (id) => constantsExported.get(id) === undefined || constantsExported.get(id) !== turndownScope.get(id)
  );
  check(
    'transient-classes (AC2): every registered name is an exported constant in constants.ts',
    notInConstants.length === 0,
    `  missing or mismatched: ${JSON.stringify(notInConstants)}`
  );

  const scan = scanStampedClasses(webviewFiles, scopes);

  // AC1 — the actual gate: a class stamped anywhere in media/webview must be
  // registered for strip, or exempted for the specific file that stamps it.
  const exemptSites = new Set(OUTSIDE_CONTENT_CLASSES);
  const unregistered: Array<{ name: string; site: StampSite }> = [];
  for (const [name, sites] of scan.names) {
    if (registered.has(name)) {
      continue;
    }
    for (const site of sites) {
      if (!exemptSites.has(`${site.file} | ${name}`)) {
        unregistered.push({ name, site });
      }
    }
  }
  check(
    'transient-classes (AC1): no unregistered class is stamped in media/webview',
    unregistered.length === 0,
    unregistered
      .map(
        ({ name, site }) =>
          `  "${name}" added at ${site.file}:${site.line}` +
          ` — register it in turndown.ts's TRANSIENT_CLASSES if it lands inside #content,` +
          ` else add "${site.file} | ${name}" to OUTSIDE_CONTENT_CLASSES in test/transient-class-scan.ts`
      )
      .join('\n')
  );

  // AC1 — "cannot resolve = fail": a computed class expression, and anything the
  // scan could not parse at all, is a failure until someone parks it on the
  // exemption array with a reason.
  const exemptExpressions = new Set(UNRESOLVED_STAMP_EXEMPTIONS);
  const rogueExpressions = scan.unresolved.filter(
    (u) => !exemptExpressions.has(`${u.file} | ${u.expr}`)
  );
  check(
    'transient-classes (AC1): no unreadable class expression is unaccounted for',
    rogueExpressions.length === 0,
    rogueExpressions
      .map(
        (u) =>
          `  ${u.file}:${u.line} stamps \`${u.expr}\`` +
          ` — resolve it to a constants.ts constant if it names a #content class,` +
          ` else add "${u.file} | ${u.expr}" to UNRESOLVED_STAMP_EXEMPTIONS in test/transient-class-scan.ts`
      )
      .join('\n')
  );

  // AC2 — a registered class must never be stamped as a bare string literal:
  // that is the second declaration site the rule exists to prevent.
  const literalRegistered = [...scan.literalNames.entries()].filter(([name]) =>
    registered.has(name)
  );
  check(
    'transient-classes (AC2): no registered class is stamped as a bare literal',
    literalRegistered.length === 0,
    literalRegistered
      .map(([name, sites]) => `  "${name}" at ${sites[0].file}:${sites[0].line}`)
      .join('\n')
  );

  // Both exemption arrays are grandfather lists, not permanent policy — an entry
  // whose stamp site is gone must be deleted, or the list quietly grows into a
  // place where a real leak can hide.
  const liveSites = new Set<string>();
  for (const [name, sites] of scan.names) {
    for (const site of sites) {
      liveSites.add(`${site.file} | ${name}`);
    }
  }
  const staleClassExemptions = OUTSIDE_CONTENT_CLASSES.filter((key) => !liveSites.has(key));
  check(
    'transient-classes: OUTSIDE_CONTENT_CLASSES has no stale entry',
    staleClassExemptions.length === 0,
    `  no longer stamped anywhere: ${JSON.stringify(staleClassExemptions)}`
  );
  const liveExpressions = new Set(scan.unresolved.map((u) => `${u.file} | ${u.expr}`));
  const staleExprExemptions = UNRESOLVED_STAMP_EXEMPTIONS.filter((k) => !liveExpressions.has(k));
  check(
    'transient-classes: UNRESOLVED_STAMP_EXEMPTIONS has no stale entry',
    staleExprExemptions.length === 0,
    `  no longer stamped anywhere: ${JSON.stringify(staleExprExemptions)}`
  );

  // The third obligation `turndown.ts`'s own comment states: registering a class
  // without a strip case leaves the registration itself unproven. Named-case and
  // clone-safety arrays there are hand-written string lists, so pin them against
  // the live strip list rather than trusting them to stay in sync.
  const stripTestSource = fs.readFileSync(
    path.join(process.cwd(), 'test/roundtrip/style-preservation.ts'),
    'utf8'
  );
  const withoutStripCase = [...registered].filter((name) => !stripTestSource.includes(`'${name}'`));
  check(
    'transient-classes: every registered class has a strip case in style-preservation.ts',
    withoutStripCase.length === 0,
    `  no roundtrip case names: ${JSON.stringify(withoutStripCase)}`
  );

  // --- Positive controls: the scan must actually see each shape it claims to.
  const probe = (source: string): ReturnType<typeof scanStampedClasses> => {
    const files: SourceFile[] = [{ file: 'probe.ts', source }];
    return scanStampedClasses(files, collectClassConstants(files));
  };

  const added = probe(`node.classList.add('brand-new-content-class');`);
  check(
    'transient-classes (control): a new classList.add literal is reported',
    added.names.has('brand-new-content-class') && added.unresolved.length === 0
  );

  const multi = probe(`node.className = 'first-class second-class';`);
  check(
    'transient-classes (control): a multi-name className assignment reports both names',
    multi.names.has('first-class') && multi.names.has('second-class')
  );

  const viaAttr = probe(`svg.setAttribute('class', 'attr-stamped-class');`);
  check(
    "transient-classes (control): setAttribute('class', …) is reported",
    viaAttr.names.has('attr-stamped-class')
  );

  const otherAttr = probe(`svg.setAttribute('viewBox', '0 0 16 16');`);
  check(
    'transient-classes (control): a non-class setAttribute is not mistaken for a stamp',
    otherAttr.names.size === 0 && otherAttr.unresolved.length === 0
  );

  const computed = probe('node.className = `mode-${current}`;');
  check(
    'transient-classes (control): a template-literal class is reported as unresolved, never silently passed',
    computed.names.size === 0 && computed.unresolved.length === 1
  );

  const viaConstant = probe(
    `const PROBE_CLASS = 'probe-resolved';\nnode.classList.add(PROBE_CLASS);`
  );
  check(
    'transient-classes (control): a constant stamp resolves to its literal, not to the identifier',
    viaConstant.names.has('probe-resolved') && !viaConstant.names.has('PROBE_CLASS')
  );

  const toggled = probe(`node.classList.toggle('toggled-class', enabled);`);
  check(
    'transient-classes (control): classList.toggle reports the class but not its force argument',
    toggled.names.has('toggled-class') && toggled.unresolved.length === 0
  );

  const compared = probe(`if (node.className === 'not-a-stamp') { return; }`);
  check(
    'transient-classes (control): a className comparison is not mistaken for a stamp',
    compared.names.size === 0 && compared.unresolved.length === 0
  );

  // --- Controls for the shapes a 2026-07-28 review found silently unscanned.
  // Every one of these returned BOTH an empty name set and an empty unresolved
  // list before the fix, i.e. the gate reported success on a stamp it never read.
  const wrappedAdd = probe(`node.classList.add(\n  'wrapped-class',\n);`);
  check(
    'transient-classes (control): a classList.add whose arguments start on the next line is still read',
    wrappedAdd.names.has('wrapped-class') && wrappedAdd.unresolved.length === 0
  );

  const wrappedTwoArgs = probe(`node.classList.add(\n  'first-wrapped',\n  'second-wrapped'\n);`);
  check(
    'transient-classes (control): a wrapped multi-argument classList.add drops neither name',
    wrappedTwoArgs.names.has('first-wrapped') && wrappedTwoArgs.names.has('second-wrapped')
  );

  const wrappedToggle = probe(`node.classList.toggle(\n  'wrapped-toggle',\n  on\n);`);
  check(
    'transient-classes (control): a wrapped classList.toggle is still read',
    wrappedToggle.names.has('wrapped-toggle') && wrappedToggle.unresolved.length === 0
  );

  const wrappedTernary = probe(`node.className = isEnd\n  ? 'ternary-a'\n  : 'ternary-b';`);
  check(
    'transient-classes (control): a wrapped ternary assignment reports one whole expression, not a truncated one',
    wrappedTernary.unresolved.length === 1 &&
      wrappedTernary.unresolved[0].expr === "isEnd ? 'ternary-a' : 'ternary-b'"
  );

  const appended = probe(`node.className += ' appended-class';`);
  check(
    'transient-classes (control): `className +=` is scanned like an assignment',
    appended.names.has('appended-class')
  );

  const replaced = probe(`node.classList.replace('replace-old', 'replace-new');`);
  check(
    'transient-classes (control): classList.replace reports both class names',
    replaced.names.has('replace-old') && replaced.names.has('replace-new')
  );

  const optionalChain = probe(`node.classList?.add('optional-chain-class');`);
  check(
    'transient-classes (control): the optional-chain spelling is scanned',
    optionalChain.names.has('optional-chain-class')
  );

  const inComment = probe(`// node.classList.add('ghost-from-comment')\nconst x = 1;`);
  check(
    'transient-classes (control): a stamp shown inside a comment is not treated as real',
    inComment.names.size === 0 && inComment.unresolved.length === 0
  );

  const inBlockComment = probe(`/* node.classList.add('ghost-from-block') */\nconst x = 1;`);
  check(
    'transient-classes (control): a stamp shown inside a block comment is not treated as real',
    inBlockComment.names.size === 0 && inBlockComment.unresolved.length === 0
  );

  const urlInString = probe(`const u = 'https://x';\nnode.classList.add('after-url-class');`);
  check(
    'transient-classes (control): a // inside a string literal does not blind the rest of the line',
    urlInString.names.has('after-url-class')
  );

  const parenInLiteral = probe(`node.classList.add('has)paren');`);
  check(
    'transient-classes (control): a parenthesis inside a class literal does not truncate the argument',
    parenInLiteral.names.has('has)paren') && parenInLiteral.unresolved.length === 0
  );

  const emptyLiteral = probe(`node.classList.add('');`);
  check(
    'transient-classes (control): an empty class literal is reported, not silently dropped',
    emptyLiteral.names.size === 0 && emptyLiteral.unresolved.length === 1
  );

  const unclosed = probe(`node.classList.add('never-closed'`);
  check(
    'transient-classes (control): an unparsable stamp is reported, not silently dropped',
    unclosed.unresolved.length === 1
  );
}


// ---------------------------------------------------------------------------
// US-23.10 AC9 write-path tripwire (src/comments/commentController.ts) — every
// route that persists a user-authored body must neutralize it. Read as text for
// the same reason as the provider.ts tripwires above: the module imports
// 'vscode'.
//
// This exists because the guarantee was originally applied per SURFACE (the
// webview popover/composer normalized; the native `vscode.comments` reply widget
// and Save did not), so `orcaEditor.replyComment` wrote an unstripped body
// straight to the sidecar. Moving it to the write path makes one place
// authoritative — and this check is what keeps a NEW write path from being added
// without it.
// ---------------------------------------------------------------------------
{
  const controllerSrc = fs.readFileSync(
    path.join(process.cwd(), 'src/comments/commentController.ts'),
    'utf8'
  );

  // Every method on the returned controller, in source order, so a body-writing
  // path added later is sliced out and checked like the three below.
  const methods: { name: string; body: string }[] = [];
  const methodRe = /^ {4}(?:async )?([A-Za-z][A-Za-z0-9]*)\(/gm;
  const starts: { name: string; at: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = methodRe.exec(controllerSrc)) !== null) {
    starts.push({ name: m[1], at: m.index });
  }
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].at : controllerSrc.length;
    methods.push({ name: starts[i].name, body: controllerSrc.slice(starts[i].at, end) });
  }

  const NEUTRALIZE = 'neutralizeCommentBody(normalizeCommentBodyEol(msg.body))';
  // A method persists a user-authored body if it hands one to a sidecar line
  // builder. Keyed off the builders rather than a hardcoded method list so a new
  // write path cannot opt itself out by not being named here.
  const BODY_LINE_BUILDERS = ['buildCommentLine(', 'buildReplyLine(', 'buildEditLine('];
  const bodyWriters = methods.filter((f) => BODY_LINE_BUILDERS.some((b) => f.body.includes(b)));

  check(
    'AC9 tripwire: the three known body-write paths are still the ones found',
    bodyWriters.map((f) => f.name).sort().join(',') === 'createThread,editComment,reply'
  );

  for (const f of bodyWriters) {
    check(
      `AC9 tripwire: ${f.name} neutralizes the body before persisting it`,
      f.body.includes(NEUTRALIZE)
    );
  }

  // The neutralized local must be what reaches the builder — reading `msg.body`
  // again downstream would silently bypass the call above.
  check(
    'AC9 tripwire: no write path passes the raw msg.body as a line body',
    !controllerSrc.includes('body: msg.body')
  );
}


// ---------------------------------------------------------------------------
// US-23.14 webview→host ROUTE GUARD — every message type the webview posts must
// have a matching `case` in src/provider.ts's `onDidReceiveMessage` switch.
//
// This exists because a CRITICAL bug survived a green 668-test suite: the switch
// had no `case 'editComment'`, so every Save from the comment popover posted a
// message nothing consumed, and the popover sat there until its own 10s timeout
// reported "No response from the host".
//
// Nothing else in the project can catch that class of bug:
//   - `tsc` cannot. The switch is not exhaustiveness-guarded (no `never` default),
//     so a `WebviewToHost` member with no `case` is not a type error.
//   - The Playwright specs cannot. `test/webview/_harness.ts` stubs
//     `acquireVsCodeApi`, so the host end of the channel does not exist there;
//     every spec fabricates the reply it wants. A misrouted message is invisible.
//
// Read as text, and against provider.ts, for the same reason as the tripwires
// above: the module imports 'vscode' and cannot be imported here.
//
// DIRECTIONS. This checks posted ⊆ provider `case`s, and nothing else:
//   - posted but no `case` → ENFORCED here. The bug above. Unreachable by tsc.
//   - posted but not in the `WebviewToHost` union → enforced by the COMPILER, not
//     here. `VsCodeApi.postMessage` took `msg: unknown` while the bug landed,
//     which left the ~20 direct `vscode.postMessage({...})` call sites unchecked
//     against the contract; it now takes `WebviewToHost`, so this direction needs
//     no text check.
//   - declared in the union but never posted → NOT enforced. Deliberate: the
//     union is also the host's own vocabulary, and a type may legitimately be
//     declared before the UI that posts it exists. Failing on it would punish
//     ordinary work-in-progress rather than catch a broken route.
//   - a `case` with no poster → NOT enforced, same reason in reverse: dead-looking
//     cases are cheap, and a route that is handled but unused breaks nothing.
// ---------------------------------------------------------------------------
{
  const WEBVIEW_SRC_DIR = path.join(process.cwd(), 'media/webview');

  /**
   * Blank out comments so prose mentioning a post call is not read as one, while
   * keeping every byte offset — string literals are walked rather than skipped,
   * so a `//` inside `'https://…'` cannot blind the rest of its line.
   */
  const blankComments = (src: string): string => {
    let out = '';
    for (let i = 0; i < src.length; ) {
      const two = src.slice(i, i + 2);
      if (two === '//') {
        while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
        continue;
      }
      if (two === '/*') {
        while (i < src.length && src.slice(i, i + 2) !== '*/') { out += src[i] === '\n' ? '\n' : ' '; i++; }
        out += '  ';
        i += 2;
        continue;
      }
      const q = src[i];
      if (q === '"' || q === "'" || q === '`') {
        out += q;
        i++;
        while (i < src.length) {
          // A `'`/`"` string cannot span a raw newline, so bail at end of line.
          // This walker cannot recognize a regex literal, and a quote character
          // inside one (`/['"]/`, `s.replace(/"/g, …)`) opens a phantom string;
          // unbounded, that phantom runs to the next quote ANYWHERE in the file
          // and every comment in between silently stops being blanked. Measured
          // before this bail: 189 comment lines across 5 real modules were being
          // scanned as live code. Backticks legitimately span lines, so they keep
          // the unbounded walk.
          if (q !== '`' && src[i] === '\n') { break; }
          if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
          out += src[i];
          i++;
          if (src[i - 1] === q) { break; }
        }
        continue;
      }
      out += q;
      i++;
    }
    return out;
  };

  /** Text of the balanced argument list starting at `open` (the `(` index). */
  const argAt = (src: string, open: number): string | null => {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (c === '(') { depth++; } else if (c === ')') {
        depth--;
        if (depth === 0) { return src.slice(open + 1, i); }
      } else if (c === '"' || c === "'" || c === '`') {
        i++;
        while (i < src.length && src[i] !== c) { i += src[i] === '\\' ? 2 : 1; }
      }
    }
    return null;
  };

  /**
   * The `type` discriminant of an object-literal argument. Reads `type` only at
   * the literal's own brace depth, so a nested object carrying its own `type`
   * cannot be mistaken for the message's.
   */
  const discriminantOf = (arg: string): { type: string } | { unreadable: string } => {
    const t = arg.trimStart();
    if (!t.startsWith('{')) { return { unreadable: t.slice(0, 60) }; }
    let depth = 0;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === '{') { depth++; continue; }
      if (c === '}') { depth--; continue; }
      if (c === '"' || c === "'" || c === '`') {
        i++;
        while (i < t.length && t[i] !== c) { i += t[i] === '\\' ? 2 : 1; }
        continue;
      }
      // The preceding-character test is what keeps a key that merely ENDS in
      // `type` from being read as the discriminant: without it `{ subtype: 'a',
      // type: 'realOne' }` returns `a`, which means the guard demands a case for
      // `a` and never checks `realOne` — green on a route that does not exist,
      // the precise failure mode this whole block is built against.
      if (depth === 1 && /^type\s*:/.test(t.slice(i)) && !/[\w$]/.test(t[i - 1] ?? '')) {
        // All three quote styles: a `type: "x"` or `` type: `x` `` post site is
        // perfectly valid source, and reporting it unreadable would be a failure
        // nobody can fix except by rewriting working code to suit this scanner.
        const m = /^type\s*:\s*(['"`])([^'"`]+)\1/.exec(t.slice(i));
        return m ? { type: m[2] } : { unreadable: t.slice(i, i + 60) };
      }
    }
    return { unreadable: t.slice(0, 60) };
  };

  const webviewSources = fs
    .readdirSync(WEBVIEW_SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({
      file: name,
      source: blankComments(fs.readFileSync(path.join(WEBVIEW_SRC_DIR, name), 'utf8')),
    }));

  // Which functions post to the host is DERIVED from the declared contract —
  // anything whose parameter is typed `WebviewToHost` is a sink — rather than
  // read off a list typed in here, so a new wrapper (a third `postToHost`, a
  // renamed one) cannot opt its call sites out of this check by not being named.
  // Same property as the AC9 tripwire above keying off the line builders.
  //
  // Found by walking BACKWARDS from each `WebviewToHost` annotation to the `(`
  // that opens its parameter list and then to the name in front of it, instead of
  // matching the whole declaration with one regex. The declaration's shape then
  // stops mattering: `function post(msg: WebviewToHost)`, `const post = (msg:
  // WebviewToHost) =>`, `post?: (msg: WebviewToHost) => void`, a second
  // parameter, a union, a trailing comma and a prettier line break all resolve to
  // the same sink. A single-regex version recognized only the first of those —
  // measured — which would have let a wrapper written any other way silently
  // un-scan every one of its call sites while the floors below still passed.
  const sinkNames = new Set<string>(['postMessage']);
  // Per FILE, not global. These names are used to recognize a wrapper forwarding
  // its own parameter (`postMessage(msg)`) and skip it. Held globally, the single
  // name `msg` — which every sink here happens to use — silently excused
  // `postMessage(msg)` in ANY module, so a genuinely new route built as a local
  // (`const msg = { type: 'newThing' }; vscode.postMessage(msg);`) was dropped
  // with no finding at all. Verified: that exact shape passed 759/0 before this
  // was scoped, and is reported as unreadable after.
  const forwardedParamsByFile = new Map<string, Set<string>>();
  for (const { file, source } of webviewSources) {
    const params = new Set<string>();
    forwardedParamsByFile.set(file, params);
    const annRe = /([A-Za-z_$][\w$]*)\s*\??\s*:\s*WebviewToHost\b/g;
    let a: RegExpExecArray | null;
    while ((a = annRe.exec(source)) !== null) {
      params.add(a[1]);
      let j = a.index;
      let depth = 0;
      while (j >= 0 && !(source[j] === '(' && depth === 0)) {
        if (source[j] === ')') { depth++; } else if (source[j] === '(') { depth--; }
        j--;
      }
      if (j < 0) { continue; }
      // Past the `(`, then past whatever punctuation separates the name from it
      // (`= (`, `: (`, `?: (`), then back over the name itself.
      j--;
      while (j >= 0 && /[\s:=?(]/.test(source[j])) { j--; }
      const nameEnd = j + 1;
      while (j >= 0 && /[\w$]/.test(source[j])) { j--; }
      const name = source.slice(j + 1, nameEnd);
      if (name && !/^\d/.test(name)) { sinkNames.add(name); }
    }
  }

  const postedTypes = new Map<string, Set<string>>();
  const unreadableCalls: string[] = [];
  for (const { file, source } of webviewSources) {
    for (const sink of sinkNames) {
      const callRe = new RegExp(`(?:^|[^\\w$.])((?:[\\w$.]+\\.)?)${sink}\\s*\\(`, 'g');
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(source)) !== null) {
        // `window.postMessage`/`self.postMessage` is a same-page message, not a
        // post to the host, and demanding a provider `case` for one would be a
        // failure no route could satisfy. None exists in these modules today; the
        // receiver is captured so that stays true if one is added.
        if (/^(?:window|self|parent|top|globalThis)\.$/.test(m[1])) { continue; }
        const open = m.index + m[0].length - 1;
        const arg = argAt(source, open);
        if (arg === null) {
          unreadableCalls.push(`${file}: unbalanced ${sink}(`);
          continue;
        }
        const trimmed = arg.trim();
        // The sink's own declaration (`msg: WebviewToHost`), and a wrapper
        // forwarding its parameter onward (`postMessage(msg)`) — neither names a
        // type, and neither is a real post site.
        if (
          /^[\w$]+\s*:\s*[\w$<>[\]|\s]+$/.test(trimmed) ||
          forwardedParamsByFile.get(file)?.has(trimmed)
        ) {
          continue;
        }
        const found = discriminantOf(arg);
        if ('type' in found) {
          if (!postedTypes.has(found.type)) { postedTypes.set(found.type, new Set()); }
          postedTypes.get(found.type)!.add(file);
        } else {
          // Reported, never skipped: a post site this scan cannot read is a hole
          // in the guard and has to be visible rather than quietly dropped.
          unreadableCalls.push(`${file}: ${sink}(${found.unreadable}`);
        }
      }
    }
  }

  // Both quote styles, and no `^` anchor, so a fall-through pair written on one
  // line (`case 'undo': case 'redo':`) contributes both labels rather than only
  // the first — either omission would be a false FAILURE naming a route that is
  // in fact handled.
  const providerCases = new Set(
    [...providerSrc.matchAll(/\bcase\s+['"]([^'"]+)['"]\s*:/g)].map((m) => m[1])
  );

  // The `case` scan above reads the WHOLE file, which is only sound while
  // `onDidReceiveMessage`'s switch is the only switch in it. With a second one, a
  // `case` in some unrelated dispatch could satisfy a route that the message
  // switch never handles — the guard would go green on exactly the bug it exists
  // to catch. Pinned as an assumption rather than parsed: brace-matching 3300
  // lines of template literals to isolate the switch body is its own bug surface,
  // so this fails and asks to be tightened the day a second switch appears.
  const providerSwitches = (providerSrc.match(/\bswitch\s*\(/g) ?? []).length;
  check(
    'route guard: provider.ts has exactly one switch, so the whole-file case scan is sound',
    providerSwitches === 1,
    `  switches = ${providerSwitches} — scope the case scan to onDidReceiveMessage's own switch body`
  );

  // Floors, so a broken regex or a moved directory reports itself instead of
  // yielding a triumphantly empty scan that passes. 30 posted types, 30 cases and
  // 2 sinks when this landed; loose on purpose — this guards against collapse.
  check(
    'route guard: the scan actually reached the webview modules and found sinks',
    webviewSources.length >= 50 && sinkNames.size >= 2,
    `  files = ${webviewSources.length}, sinks = ${[...sinkNames].join(',')}`
  );
  check(
    'route guard: the scan found the posted message types and the provider switch',
    postedTypes.size >= 25 && providerCases.size >= 25,
    `  posted = ${postedTypes.size}, provider cases = ${providerCases.size}`
  );
  check(
    'route guard: every post site was readable',
    unreadableCalls.length === 0,
    unreadableCalls.map((u) => `  ${u}`).join('\n')
  );

  for (const [type, files] of [...postedTypes].sort((a, b) => a[0].localeCompare(b[0]))) {
    check(
      `route guard: '${type}' has a case in provider.ts's onDidReceiveMessage`,
      providerCases.has(type),
      `  posted from ${[...files].sort().join(', ')} but no \`case '${type}':\` in src/provider.ts` +
        ' — the host would receive it and do nothing (US-23.14)'
    );
  }
}


// ---------------------------------------------------------------------------
// Performance Audit P-9 — block patch plan (media/webview/block-patch.ts)
// ---------------------------------------------------------------------------

{
  eq('P-9 plan: identical lists → everything kept, empty changed run', planBlockPatch(['a', 'b', 'c'], ['a', 'b', 'c']), {
    prefix: 3,
    suffix: 0,
  });
  eq('P-9 plan: one changed block in the middle', planBlockPatch(['a', 'b', 'c'], ['a', 'x', 'c']), { prefix: 1, suffix: 1 });
  eq('P-9 plan: insertion keeps both neighbours', planBlockPatch(['a', 'b'], ['a', 'x', 'b']), { prefix: 1, suffix: 1 });
  eq('P-9 plan: deletion keeps both neighbours', planBlockPatch(['a', 'x', 'b'], ['a', 'b']), { prefix: 1, suffix: 1 });
  eq('P-9 plan: nothing in common → full replace', planBlockPatch(['a', 'b'], ['x', 'y']), { prefix: 0, suffix: 0 });
  eq('P-9 plan: empty old list (first content)', planBlockPatch([], ['a']), { prefix: 0, suffix: 0 });
  eq('P-9 plan: empty new list (document cleared)', planBlockPatch(['a'], []), { prefix: 0, suffix: 0 });
  // Repeated blocks: prefix + suffix must never claim the same live node twice.
  eq('P-9 plan: repeated blocks clamp (aa → aaa)', planBlockPatch(['a', 'a'], ['a', 'a', 'a']), { prefix: 2, suffix: 0 });
  eq('P-9 plan: repeated blocks clamp (a → aa)', planBlockPatch(['a'], ['a', 'a']), { prefix: 1, suffix: 0 });

  const keyDoc = domino.createDocument('', true);
  const key = (html: string): string => {
    const host = keyDoc.createElement('div');
    host.innerHTML = html;
    return lineAgnosticKey(host.firstElementChild!);
  };
  check(
    'P-9 key: two renders differing only in line values share one key',
    key('<p data-line="3" data-line-end="4">x</p>') === key('<p data-line="7" data-line-end="9">x</p>')
  );
  check(
    'P-9 key: nested list-item line values are normalized too',
    key('<ul data-line="1" data-line-end="2"><li data-line="1">a</li></ul>') ===
      key('<ul data-line="5" data-line-end="6"><li data-line="5">a</li></ul>')
  );
  check('P-9 key: content changes change the key', key('<p data-line="3">x</p>') !== key('<p data-line="3">y</p>'));
  check(
    'P-9 key: a literal data-line=... inside TEXT is content, not an attribute (iter-1 review)',
    key('<p data-line="1"><code>see data-line="5" here</code></p>') !==
      key('<p data-line="1"><code>see data-line="7" here</code></p>')
  );
  check(
    'P-9 key: carrier PRESENCE is part of the key (setext/atx, indented/fenced replaced, not kept)',
    key('<h1 data-line="3" data-line-end="4">T</h1>') !== key('<h1 data-line="3">T</h1>')
  );
  check(
    'P-9 key: attributes merely starting with data-line are untouched content',
    key('<p data-lineage="3">x</p>') === key('<p data-lineage="3">x</p>') &&
      key('<p data-lineage="3">x</p>') !== key('<p data-lineage="4">x</p>')
  );
}

{
  // copySrcLines zips the carrier lists (self + descendants) and copies both attrs.
  const doc = domino.createDocument(
    '<div id="from"><ul data-line="10" data-line-end="13"><li data-line="10">x</li><li data-line="12" data-line-end="13">y</li></ul></div>' +
      '<div id="to"><ul data-line="3" data-line-end="6"><li data-line="3">x</li><li data-line="5" data-line-end="6">y</li></ul></div>',
    true
  );
  const from = doc.querySelector('#from > ul')!;
  const to = doc.querySelector('#to > ul')!;
  copySrcLines(from, to);
  eq(
    'P-9 copySrcLines: block and nested carriers adopt the fresh values',
    [
      to.getAttribute('data-line'),
      to.getAttribute('data-line-end'),
      ...Array.from(to.querySelectorAll('li')).map((li) => `${li.getAttribute('data-line')}/${li.getAttribute('data-line-end')}`),
    ],
    ['10', '13', '10/null', '12/13']
  );

  // Guard: a carrier-count mismatch copies nothing rather than misaligning.
  const guarded = doc.createElement('p');
  guarded.setAttribute('data-line', '2');
  copySrcLines(from, guarded);
  eq('P-9 copySrcLines: carrier-count mismatch leaves the target untouched', guarded.getAttribute('data-line'), '2');
}

// ---------------------------------------------------------------------------
// US-2.10 — TOML front matter: the `+++` pre-scan and its gutter contract.
// The pre-scan runs outside markdown-it, so `render()` and the debounced
// `computeTopLevelBlockRanges()` must agree exactly: a range the gutter path
// computed differently would renumber blocks on every keystroke.
// ---------------------------------------------------------------------------

{
  const renderer = new MarkdownRenderer({ breaks: false, linkify: true });
  const firstBlock = (
    md: string
  ): { format: string | null; line: string | null; view: string | null; count: string | null; note: string | null; bodyLine: string | null } => {
    const doc = domino.createDocument(`<div>${renderer.render(md).html}</div>`, true);
    const fm = doc.querySelector('.md-front-matter');
    return {
      format: fm ? fm.getAttribute('data-fm-format') : null,
      line: fm ? fm.getAttribute('data-line') : null,
      view: fm ? fm.getAttribute('data-fm-view') : null,
      count: fm?.querySelector('.md-fm-count')?.textContent ?? null,
      note: fm?.querySelector('.md-fm-error-line')?.textContent ?? null,
      bodyLine: doc.querySelector('h1')?.getAttribute('data-line') ?? null,
    };
  };
  const gridText = (md: string): string => {
    const doc = domino.createDocument(`<div>${renderer.render(md).html}</div>`, true);
    return doc.querySelector('.md-fm-grid')?.textContent ?? '';
  };
  const firstRange = (md: string): unknown => renderer.computeTopLevelBlockRanges(md)[0]?.range ?? null;

  const TOML_DOC = '+++\ntitle = "T"\nweight = 3\n+++\n\n# Heading\n\nBody.\n';
  const EMPTY_TOML = '+++\n+++\n\n# Heading\n';

  eq('US-2.10 AC1: a `+++` block on line 1 is captured as TOML front matter', firstBlock(TOML_DOC), {
    format: 'toml',
    line: '1',
    view: 'collapsed',
    count: '2 fields',
    note: null,
    bodyLine: '6',
  });
  // Asserting the view and the field count, not just the format attribute:
  // the invalid wrapper carries `data-fm-format` too, so a format-only check
  // would pass even if every CRLF document collapsed into the error frame.
  eq('US-2.10 AC1: CRLF authoring detects and parses identically', firstBlock(TOML_DOC.replace(/\n/g, '\r\n')), {
    format: 'toml',
    line: '1',
    view: 'collapsed',
    count: '2 fields',
    note: null,
    bodyLine: '6',
  });
  eq('US-2.10 AC2: an unclosed `+++` captures nothing rather than autoclosing at EOF', firstBlock('+++\ntitle = "T"\n\n# Heading\n').format, null);
  eq('US-2.10 AC4: a `+++` that is not line 1 is ordinary markdown', firstBlock('# Heading\n\n+++\nnot = "front matter"\n+++\n').format, null);
  eq('US-2.10 AC4/AC11: a `---` document is still captured as YAML', firstBlock('---\ntitle: T\n---\n\n# Heading\n').format, 'yaml');

  eq('US-2.10 AC5: `+++\\n+++` is a valid 0-field card, not the invalid frame', firstBlock(EMPTY_TOML).view, 'collapsed');
  // The reported position, not merely the invalid state: an implementation
  // that always answered "Line 1" would pass a view-only assertion.
  eq('US-2.10 AC8: malformed TOML reports the offending line within the block', firstBlock('+++\na = 1\nb = 2\nkey = \n+++\n\n# Heading\n'), {
    format: 'toml',
    line: '1',
    view: 'invalid',
    count: null,
    note: 'Line 3',
    // Still line-aligned: the invalid path blanks the same lines as the valid one.
    bodyLine: '7',
  });

  // A TOML integer arrives as a bigint, which JSON.stringify throws on — a
  // deeper structure holding one must still show its compact JSON, not the
  // unserializable placeholder. `[[menu.main]]` with a `weight` is the
  // canonical Hugo shape that triggers it.
  const HUGO_MENU = '+++\ntitle = "T"\n\n[[menu.main]]\nname = "home"\nweight = 10\n+++\n\n# Heading\n';
  check('US-2.10 AC7: a bigint nested in a deeper structure keeps its value in the compact JSON row', gridText(HUGO_MENU).includes('"weight":"10"'), `  grid: ${gridText(HUGO_MENU)}`);
  check('US-2.10 AC7: ...and never degrades to the unserializable placeholder', !gridText(HUGO_MENU).includes('unserializable'), `  grid: ${gridText(HUGO_MENU)}`);

  // AC16/AC17: same [start, end] from both consumers, and the first body block
  // still maps to its true source line because the captured region was replaced
  // by the SAME number of blank lines.
  eq('US-2.10 AC16/AC17: gutter and render agree on the front-matter range', firstRange(TOML_DOC), { start: 1, end: 4 });
  eq('US-2.10 AC17: render numbers the block from the same range', firstBlock(TOML_DOC).line, '1');
  eq('US-2.10 AC17: an empty `+++` block reports its own two-line range', firstRange(EMPTY_TOML), { start: 1, end: 2 });
  eq('US-2.10 AC17: the first body block after an empty block keeps its source line', firstBlock(EMPTY_TOML).bodyLine, '4');
  // AC3: the pre-scan writes into the same capture state `resetCaptureState()`
  // clears, so a TOML document must not leak its block or its range into the
  // next document the same renderer handles — on either consumer.
  renderer.render(TOML_DOC);
  eq('US-2.10 AC3: capture state is cleared — the next render gets no stale block', firstBlock('# Plain\n\nBody.\n').format, null);
  renderer.computeTopLevelBlockRanges(TOML_DOC);
  eq('US-2.10 AC3: ...and the gutter path gets no stale range', firstRange('# Plain\n\nBody.\n'), { start: 1, end: 1 });

  // AC9: the fallback exists as its own branch. Every `TomlError` carries
  // `line`, so only a thrown value without one can reach it.
  eq('US-2.10 AC8: a real parse error reports its own 1-based line', tomlErrorLine({ line: 3 }), 3);
  eq('US-2.10 AC9: an error with no usable position falls back to line 1', tomlErrorLine(new Error('boom')), 1);
  eq('US-2.10 AC9: a non-numeric position falls back too', tomlErrorLine({ line: '3' }), 1);
}

// ---------------------------------------------------------------------------
// US-2.11 — JSON front matter: the fence-less `{...}` pre-scan and its gutter
// contract. A leading `{` is ordinary content in every markdown file shipped
// so far, so the recognition rule carries most of this story's risk: every
// rejection path below must leave the document exactly as it renders today.
// ---------------------------------------------------------------------------

{
  const renderer = new MarkdownRenderer({ breaks: false, linkify: true });
  const firstBlock = (md: string): { format: string | null; line: string | null; view: string | null; count: string | null; bodyLine: string | null } => {
    const doc = domino.createDocument(`<div>${renderer.render(md).html}</div>`, true);
    const fm = doc.querySelector('.md-front-matter');
    return {
      format: fm ? fm.getAttribute('data-fm-format') : null,
      line: fm ? fm.getAttribute('data-line') : null,
      view: fm ? fm.getAttribute('data-fm-view') : null,
      count: fm?.querySelector('.md-fm-count')?.textContent ?? null,
      bodyLine: doc.querySelector('h1')?.getAttribute('data-line') ?? null,
    };
  };
  const rawAttr = (md: string): string | null => {
    const doc = domino.createDocument(`<div>${renderer.render(md).html}</div>`, true);
    return doc.querySelector('.md-front-matter')?.getAttribute('data-raw') ?? null;
  };
  const firstRange = (md: string): unknown => renderer.computeTopLevelBlockRanges(md)[0]?.range ?? null;

  const JSON_DOC = '{\n  "title": "T",\n  "weight": 3\n}\n\n# Heading\n\nBody.\n';
  const EMPTY_JSON = '{}\n\n# Heading\n';

  eq('US-2.11 AC1: a `{` on line 1 with a blank line after the closing brace is captured as JSON front matter', firstBlock(JSON_DOC), {
    format: 'json',
    line: '1',
    view: 'collapsed',
    count: '2 fields',
    bodyLine: '6',
  });
  eq('US-2.11 AC1: CRLF authoring detects and parses identically', firstBlock(JSON_DOC.replace(/\n/g, '\r\n')), {
    format: 'json',
    line: '1',
    view: 'collapsed',
    count: '2 fields',
    bodyLine: '6',
  });
  eq('US-2.11 AC1: a UTF-8 BOM before the brace does not disqualify the block', firstBlock(`﻿${EMPTY_JSON}`).format, 'json');

  // The two string-state rules, each with a document that a scanner missing
  // that rule would get wrong: counting braces inside strings closes early on
  // the first, and ignoring the backslash escape never closes at all on the
  // second.
  eq('US-2.11 AC1: a `}` inside a string value does not close the block', firstBlock('{"a":"}"}\n\n# Heading\n'), {
    format: 'json',
    line: '1',
    view: 'collapsed',
    count: '1 field',
    bodyLine: '3',
  });
  eq('US-2.11 AC1: a backslash-escaped quote does not end the string', firstBlock('{"a":"x\\"y"}\n\n# Heading\n').format, 'json');
  eq('US-2.11 AC1: an escaped backslash does NOT escape the quote that follows it', firstBlock('{"a":"x\\\\","b":1}\n\n# Heading\n').count, '2 fields');

  eq('US-2.11 AC1: leading whitespace before the brace means no front matter', firstBlock(' {"a":1}\n\n# Heading\n').format, null);
  eq('US-2.11 AC1: a leading blank line means no front matter', firstBlock('\n{"a":1}\n\n# Heading\n').format, null);
  eq('US-2.11 AC1: a `{` that is not on line 1 is ordinary markdown', firstBlock('# Heading\n\n{"a":1}\n').format, null);
  eq('US-2.11 AC1: a `---` document is still captured as YAML', firstBlock('---\ntitle: T\n---\n\n# Heading\n').format, 'yaml');

  eq('US-2.11 AC2: an unclosed `{` captures nothing', firstBlock('{\n  "a": 1\n\n# Heading\n').format, null);
  eq('US-2.11 AC2: an unterminated string literal captures nothing', firstBlock('{"a": "oops\n}\n\n# Heading\n').format, null);
  eq('US-2.11 AC3: matched braces holding invalid JSON are not front matter at all', firstBlock('{a: 1}\n\n# Heading\n').format, null);

  eq('US-2.11 AC4: content after the closing brace on its own line disqualifies the block', firstBlock('{"a":1} x\n\n# Heading\n').format, null);
  eq('US-2.11 AC4: trailing spaces/tabs after the closing brace are tolerated', firstBlock('{"a":1}  \t\n\n# Heading\n').format, 'json');
  eq('US-2.11 AC4: no blank line before the body means no front matter', firstBlock('{"a":1}\n# Heading\n').format, null);
  eq('US-2.11 AC4: a CRLF blank line satisfies the same rule', firstBlock('{"a":1}\r\n\r\n# Heading\r\n').format, 'json');
  eq('US-2.11 AC4: end-of-document right after the closing brace is enough', firstBlock('{"a":1}').format, 'json');
  // Review finding (step-04, edge case hunter + acceptance auditor): the
  // trailer check tolerates an unterminated whitespace tail, so the
  // end-of-document check one line below must tolerate the same thing — a file
  // ending in trailing spaces is still end-of-document.
  eq('US-2.11 AC4: a whitespace-only final line with no newline is still end-of-document', firstBlock('{"a":1}\n   ').format, 'json');
  eq('US-2.11 AC4: ...but real content on that final line is still not', firstBlock('{"a":1}\n  x').format, null);

  // AC6: unlike YAML/TOML, whose delimiter lines sit OUTSIDE `data-raw`, the
  // JSON attribute spans the braces themselves -- that is what lets turndown
  // re-emit the block with no fence and still round-trip byte-for-byte.
  eq('US-2.11 AC6: data-raw spans the opening `{` through the matching `}` inclusive', rawAttr(JSON_DOC), '{\n  "title": "T",\n  "weight": 3\n}');
  eq('US-2.11 AC6: a CRLF block keeps no stray CR in data-raw', rawAttr(JSON_DOC.replace(/\n/g, '\r\n')), '{\n  "title": "T",\n  "weight": 3\n}');

  // AC5/AC13: the captured region becomes the SAME number of blank lines, so
  // both consumers report one range and the first body block keeps its true
  // source line.
  eq('US-2.11 AC13: gutter and render agree on the front-matter range', firstRange(JSON_DOC), { start: 1, end: 4 });
  eq('US-2.11 AC5: the heading after a 4-line block still maps to line 6', firstBlock(JSON_DOC).bodyLine, '6');
  eq('US-2.11 AC8/AC13: `{}` is a valid 0-field card reporting its own one-line range', firstBlock(EMPTY_JSON), {
    format: 'json',
    line: '1',
    view: 'collapsed',
    count: '0 fields',
    bodyLine: '3',
  });
  eq('US-2.11 AC13: ...and the gutter path reports that same one-line range', firstRange(EMPTY_JSON), { start: 1, end: 1 });

  // The pre-scan writes into the state `resetCaptureState()` clears, so a JSON
  // document must not leak its block or its range into the next document the
  // same renderer handles -- on either consumer.
  renderer.render(JSON_DOC);
  eq('US-2.11: capture state is cleared — the next render gets no stale block', firstBlock('# Plain\n\nBody.\n').format, null);
  renderer.computeTopLevelBlockRanges(JSON_DOC);
  eq('US-2.11: ...and the gutter path gets no stale range', firstRange('# Plain\n\nBody.\n'), { start: 1, end: 1 });

  // AC14: the paste path shares this renderer. `scanJson: false` is what keeps
  // a pasted JSON snippet an ordinary paragraph instead of a second card in
  // the middle of the document.
  const pasted = domino.createDocument(`<div>${renderer.render(JSON_DOC, false).html}</div>`, true);
  eq('US-2.11 AC14: the paste path builds no front-matter card', pasted.querySelector('.md-front-matter') == null, true);
  eq('US-2.11 AC14: ...and a `---` block still is captured on that path, unchanged from today', renderer.render('---\ntitle: T\n---\n\n# Heading\n', false).frontMatter, 'title: T');
}

console.log(`\n${pass} pass, ${fail} fail`);
if (failures.length) {
  console.log('\n' + failures.join('\n\n'));
  process.exit(1);
}
