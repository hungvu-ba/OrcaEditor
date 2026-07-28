/**
 * Req 23 US-23.1: the extension's single `vscode.comments` CommentController —
 * the thread/reply/author/timestamp data model for review comments (the same
 * model the GitHub Pull Requests extension uses).
 *
 * US-23.5 made threads durable: a create is persisted to the per-file
 * `.orca-comments.jsonl` sidecar BEFORE the native thread exists, and a reopened
 * document reloads its threads from that sidecar. Nothing here ever touches the
 * `.md` — a comment must never occupy a slot in the document's undo stack
 * (US-23.6).
 *
 * The structural anchor recorded on each thread ({anchorId, offsetStart,
 * offsetEnd}) is authoritative; the `vscode.Range` the native API requires is a
 * best-effort translation of the anchored node's source line, kept only so the
 * thread is a valid CommentThread. Re-resolving that anchor across edits is
 * US-23.4.
 */
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import {
  anchorUpdateRejection,
  authorNamePromptRejection,
  commentThreadContextValue,
  commentThreadLine,
  createCommentRejection,
  deleteRejection,
  editRejection,
  replyRejection,
  resolveCommentAuthor,
  safeOsUsername,
  statusChangeRejection,
  STATUS_CHANGE_TARGET,
  type AnchorUpdateMessage,
  type CreateCommentMessage,
  type DeleteCommentMessage,
  type EditCommentMessage,
  type ReplyMessage,
  type StatusChangeMessage,
} from './comment-utils';
import { neutralizeCommentBody, normalizeCommentBodyEol } from './comment-body-limit';
import { sameDocumentUri } from '../text-utils';
import {
  buildAnchorUpdateLine,
  buildCommentLine,
  buildDeleteLine,
  buildEditLine,
  buildReplyLine,
  buildStatusChangeLine,
  sidecarBelongsToDocument,
  type CommentStatus,
  type SidecarThread,
} from './sidecar-format';
import type { SidecarStore } from './sidecar-store';
import type { CommentSidecarState, CommentSyncThread, CommentTransition } from '../shared/messages';

/** The structural anchor a thread was created against (US-23.1; re-resolved by US-23.4). */
export interface CommentAnchor {
  anchorId: string;
  offsetStart: number;
  offsetEnd: number;
  /** US-23.4 tier 2: the anchored node's text at creation time. */
  recordedText: string;
  /** US-23.4: 1-based line the anchor was last resolved to. */
  lastKnownLine: number;
  /** US-23.4 tier 2 tie-breaker: heading the anchored node sat under. */
  nearestHeading: string;
  /** US-23.4: which tier placed it — orthogonal to the Open/Resolved/Closed axis (US-23.3). */
  state: AnchorUpdateMessage['state'];
}

/**
 * What creating a thread produced: the refusal reason, or the identity actually
 * recorded on it. US-23.4's panel renders a floating thread's card from these,
 * and only the host knows them (the author setting is re-read at create time).
 */
export type CreateThreadOutcome =
  | { ok: false; error: string }
  | { ok: true; author: string; timestamp: string };

export interface CommentSupport extends vscode.Disposable {
  /**
   * Create one thread for a validated `createComment` request. A refused request
   * must never leave a thread against a stale/empty anchor, and its reason is
   * surfaced to the Reviewer.
   *
   * US-23.5: the sidecar line is written first — if that write fails the request
   * is refused and no thread exists, so a comment is never shown as created when
   * it would vanish on the next reopen.
   */
  createThread(msg: CreateCommentMessage, document: vscode.TextDocument): Promise<CreateThreadOutcome>;
  /**
   * US-23.4: a tier moved (or gave up on) a thread's anchor — follow it with the
   * native Range and record the new state. Returns the rejection/write-failure
   * reason or null. Never edits the document (US-23.6).
   *
   * US-23.13 AC1/AC2: when `msg.origin` is set, the transition is also
   * persisted as an `anchor-update` sidecar line (save-first, like every other
   * write) — which is why this is now async.
   */
  updateAnchor(msg: AnchorUpdateMessage, document: vscode.TextDocument): Promise<string | null>;
  /** The structural anchor a thread was created against — US-23.4 re-resolves from here. */
  anchorOf(threadId: string): CommentAnchor | undefined;
  /**
   * US-23.5 AC5: drop every thread held for a document whose uri no longer
   * resolves (renamed, moved). The reopened document then rebuilds from the moved
   * sidecar instead of showing each comment twice.
   */
  forgetDocument(uri: vscode.Uri): void;
  /**
   * US-23.5 AC4: rebuild this document's threads from its sidecar. Idempotent —
   * a second panel on the same file (or a re-entrant open) must not double the
   * threads.
   */
  loadThreads(document: vscode.TextDocument): Promise<void>;
  /**
   * US-23.10 AC7: re-check the up-front document guard (untitled / non-`file` /
   * outside-allowed-root) for a document that was previously refused, and push
   * a fresh `commentThreadsSync` if the answer changed — the bridge that lets
   * an untitled document saved to disk enable "Add Comment" without reopening
   * the editor. A no-op when nothing was ever refused for this document (the
   * common case), so it is safe to call on every save.
   */
  revalidateAfterSave(document: vscode.TextDocument): Promise<void>;
  /**
   * US-23.2: append a reply under `msg.threadId`. Validated against the
   * thread's LIVE status (Closed blocks it) — `replyRejection` needs that,
   * which only this registry has. Sidecar-append-then-native-update, same
   * order as `createThread` (US-23.6: no `TextDocument` edit either way).
   */
  reply(
    msg: ReplyMessage,
    document: vscode.TextDocument
  ): Promise<{ ok: true; replyId: string; author: string; timestamp: string } | { ok: false; error: string }>;
  /**
   * US-23.2 PO decision: delete a thread (cascading to every reply) or one
   * reply within it, gated by a soft author-match nudge. A `delete` tombstone
   * appended like every other action (US-23.6) — never a file rewrite.
   */
  deleteComment(
    msg: DeleteCommentMessage,
    document: vscode.TextDocument
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * US-23.14: correct a comment's or reply's own `body` — an append-only `edit`
   * sidecar line (US-23.5 AC2, US-23.6), never a rewrite. No authority check
   * (AC8). An unchanged-after-trim body is `{ ok: true }` with nothing appended
   * (AC2's sub-criterion: Save on unchanged text behaves as Cancel).
   */
  editComment(
    msg: EditCommentMessage,
    document: vscode.TextDocument
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * US-23.14 AC1: toggle ONE comment/reply's native editable field open or
   * closed — local display state only (no sidecar write, no message round
   * trip), the native mirror of the webview's own field open/Cancel. `replyId`
   * absent targets the thread's opening comment. Returns false when the
   * thread/target no longer exists, so the caller can no-op quietly.
   */
  setEditingMode(threadId: string, replyId: string | undefined, editing: boolean): boolean;
  /**
   * US-23.3: move a thread along Open → Resolved → Closed, or Reopen it back to
   * Open in one step. Validated against the thread's LIVE status alone (US-23.11
   * AC1 removed the identity gate) — only this registry knows it. Appends a
   * `status-change` line and never rewrites a prior one (US-23.5), never edits
   * the `.md` (US-23.6).
   */
  changeStatus(
    msg: StatusChangeMessage,
    document: vscode.TextDocument
  ): Promise<
    | { ok: true; status: CommentStatus; author: string; timestamp: string }
    | { ok: false; error: string }
  >;
  /**
   * US-23.2: the full live snapshot `syncThreadsToWebview` pushes — the bridge
   * that lets a thread the webview did not itself mint this session (loaded
   * from the sidecar, or reached from the native `vscode.comments` UI) still
   * get a gutter pin/highlight/popover.
   */
  listThreads(document: vscode.TextDocument): CommentSyncThread[];
  /**
   * US-23.9: what the sidecar load found beside the threads — a foreign sidecar,
   * a refusal/read failure, or orphaned lines. Pushed alongside `listThreads` so
   * the Comment tab can explain an empty or unexpected list instead of showing
   * "no comments" for four different causes.
   */
  sidecarStateFor(document: vscode.TextDocument): CommentSidecarState | undefined;
  /**
   * US-23.2: reverse lookup from a native `vscode.CommentThread` (what a
   * `comments/commentThread/context` command receives via its
   * `vscode.CommentReply` argument) back to the registry key `reply()`/
   * `deleteComment()` need — the native UI has no notion of this key at all.
   */
  threadIdFor(thread: vscode.CommentThread): string | undefined;
}

/** What a non-exact anchor reads as on the native thread (US-23.4 AC3/AC4). */
const ANCHOR_STATE_LABEL: Record<Exclude<AnchorUpdateMessage['state'], 'exact'>, string> = {
  approximate: 'Approximate location',
  floating: 'Unresolved location',
};

/**
 * The three derived facets of a native thread, set in ONE place so the four
 * paths that can change either axis (create, load, anchor update, status change)
 * cannot drift apart:
 *
 * - `contextValue` carries BOTH axes, built by the pure
 *   `commentThreadContextValue` (which `test/unit.ts` pins against the `when`
 *   clauses in `package.json`). A `comments/commentThread/context` menu `when`
 *   clause is the only per-thread gate the native UI offers, and US-23.3 needs
 *   the status half (which of Resolve/Close/Reopen is even applicable) while
 *   US-23.4 needs the anchor half. `createThread` used to set no `contextValue`
 *   at all, which showed none of the three actions on a thread created this
 *   session.
 * - `label` marks a drifted anchor on this surface too (US-23.4 AC3).
 * - `state` is VS Code's own two-value axis; it has no third value, so anything
 *   past Open reads as resolved there.
 */
function applyThreadFacets(
  thread: vscode.CommentThread,
  anchorState: AnchorUpdateMessage['state'],
  status: CommentStatus
): void {
  thread.contextValue = commentThreadContextValue(anchorState, status);
  thread.label = anchorState === 'exact' ? undefined : ANCHOR_STATE_LABEL[anchorState];
  thread.state =
    status === 'Open' ? vscode.CommentThreadState.Unresolved : vscode.CommentThreadState.Resolved;
}

/**
 * US-23.14: bookkeeping the base `vscode.Comment` type carries no way to
 * express — VS Code hands the exact same object reference back as the command
 * argument for `comments/comment/title`/`comments/comment/context`, so
 * stamping extra fields here (mirroring the official `vscode-extension-samples`
 * comment-sample's `NoteComment.parent` pattern) is what lets the Edit/Save/
 * Cancel handlers in `provider.ts` recover which thread — and, for a reply,
 * which one — fired, with no reverse lookup needed.
 */
export interface EditableComment extends vscode.Comment {
  orcaThreadId: string;
  orcaDocUri: string;
  /** Absent = this Comment IS the thread's opening comment; present = this reply's own durable id. */
  orcaReplyId?: string;
}

/**
 * One `comment`/`reply` line turned into a native `vscode.Comment`. Hoisted out
 * of `buildLoadedThread` (US-23.2) so `reply()`/`deleteComment()`/`editComment()`
 * build the exact same shape when they rebuild a thread's live `comments[]`,
 * instead of a second copy of the timestamp-guard drifting from this one.
 */
function asNativeComment(source: {
  author: string;
  timestamp: string;
  body: string;
  /** US-23.14 AC4: the winning `edit` line's own timestamp — never the original's. */
  editedAt?: string;
  threadId: string;
  docUri: string;
  replyId?: string;
  /** US-23.14 AC1: `Editing` only while this specific comment's native field is open — default `Preview`. */
  mode?: vscode.CommentMode;
}): EditableComment {
  return {
    // US-23.10 AC9: a plain string, never `vscode.MarkdownString` — a body
    // containing Markdown syntax or raw HTML (`<script>`...) must render as
    // literal text on the native surface, not be interpreted.
    body: source.body,
    mode: source.mode ?? vscode.CommentMode.Preview,
    author: { name: source.author },
    // An unparseable timestamp would make `new Date` Invalid Date, which VS Code
    // renders as garbage — drop it rather than show that. Always the ORIGINAL
    // comment/reply's own timestamp: US-23.14 AC2 says an edit never overwrites it.
    timestamp: Number.isNaN(Date.parse(source.timestamp)) ? undefined : new Date(source.timestamp),
    // AC4's marker, on this surface too. An empty/unparseable stamp (a
    // hand-edited or merge-mangled sidecar) still marks the body as edited,
    // just without a time — dropping the marker would make an edit silently
    // indistinguishable from the original, which AC4 forbids.
    label:
      source.editedAt === undefined
        ? undefined
        : Number.isNaN(Date.parse(source.editedAt))
          ? 'edited'
          : `edited ${new Date(source.editedAt).toLocaleString()}`,
    orcaThreadId: source.threadId,
    orcaDocUri: source.docUri,
    orcaReplyId: source.replyId,
  };
}

/**
 * `entry`'s live comment+replies rebuilt as native `Comment[]` (comment-then-
 * replies, matching every other reassembly in this file). Shared by
 * `reply()`/`deleteComment()`/`editComment()` so the three write paths that
 * mutate `entry.thread.comments` cannot drift into three different shapes.
 */
function nativeCommentsFor(entry: ThreadEntry, threadId: string, docUri: string): vscode.Comment[] {
  return [
    asNativeComment({
      author: entry.commentAuthor,
      timestamp: entry.commentTimestamp,
      body: entry.commentBody,
      editedAt: entry.commentEditedAt,
      threadId,
      docUri,
    }),
    ...entry.replies.map((r) =>
      asNativeComment({
        author: r.author,
        timestamp: r.timestamp,
        body: r.body,
        editedAt: r.editedAt,
        threadId,
        docUri,
        replyId: r.id,
      })
    ),
  ];
}

/**
 * US-23.5 AC4: one persisted thread rebuilt as a native `CommentThread` whose
 * `comments[]` runs comment-then-replies in timestamp order (already sorted by
 * `foldSidecarRecords`), so a git merge that interleaved two authors' lines still
 * displays one coherent conversation.
 */
function buildLoadedThread(
  controller: vscode.CommentController,
  document: vscode.TextDocument,
  persisted: SidecarThread,
  /**
   * `floating` when the sidecar turned out not to belong to this document at all
   * (AC7 clause 2 — a `.md` deleted and recreated at the same path), otherwise
   * `approximate`: placed from a recorded line, never a live structural id.
   */
  state: 'approximate' | 'floating'
): vscode.CommentThread {
  // last_known_line is 1-based and can sit past the end of a document that has
  // been cut down since the comment was written. `persisted.anchor` (not
  // `persisted.comment.anchor`) is the loader's folded position — US-23.13
  // AC1/AC2's `anchor-update` line if one exists, else the creation-time one.
  const line = Math.min(
    commentThreadLine(persisted.anchor.last_known_line),
    Math.max(0, document.lineCount - 1)
  );
  const docUri = document.uri.toString();
  const thread = controller.createCommentThread(document.uri, new vscode.Range(line, 0, line, 0), [
    asNativeComment({
      author: persisted.comment.author,
      timestamp: persisted.comment.timestamp,
      body: persisted.comment.body,
      editedAt: persisted.comment.editedAt,
      threadId: persisted.id,
      docUri,
    }),
    ...persisted.replies.map((r) =>
      asNativeComment({
        author: r.author,
        timestamp: r.timestamp,
        body: r.body,
        editedAt: r.editedAt,
        threadId: persisted.id,
        docUri,
        replyId: r.id,
      })
    ),
  ]);
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
  // Placed from a recorded line, not a live structural id — marked on this surface
  // too (US-23.4 AC3), alongside the folded Open/Resolved/Closed status (US-23.3).
  applyThreadFacets(thread, state, persisted.status);
  return thread;
}

interface ThreadEntry {
  thread: vscode.CommentThread;
  anchor: CommentAnchor;
  /** The durable sidecar `comment` id this thread was written as / loaded from. */
  commentId: string | null;
  /** US-23.2: the original comment's own author/body/timestamp — read-only for the Author, own-authored-only for delete. */
  commentAuthor: string;
  commentBody: string;
  commentTimestamp: string;
  /** US-23.14 AC4: the winning `edit` line's timestamp, once the opening comment has been edited at least once. */
  commentEditedAt?: string;
  /** US-23.3's axis, folded from status-change lines. */
  status: CommentStatus;
  /**
   * US-23.11 AC2: every applied transition, in fold order — the thread's audit
   * trail, so a reader can tell whether Resolve and Close came from two people.
   * Empty while the thread has never left Open. Lines the loader skipped as
   * illegal (AC6) are not here: they never took effect.
   */
  statusChanges: CommentTransition[];
  /** US-23.2: live reply list — each reply's own durable id is what a later single-reply delete/edit names. */
  replies: Array<{ id: string; author: string; timestamp: string; body: string; editedAt?: string }>;
}

export function createCommentSupport(
  store: SidecarStore,
  log: (message: string, err?: unknown) => void,
  /** Whether this filesystem folds case — see `docKeyFor`. */
  caseInsensitive: boolean
): CommentSupport {
  const controller = vscode.comments.createCommentController(
    'orcaEditor.comments',
    'Orca Editor Comments'
  );
  // Threads are placed from the webview's structural anchor, never by dragging a
  // range in the text editor's gutter — so no commentingRangeProvider.
  //
  // Keyed by the webview's threadId (US-23.4): the webview owns re-resolution and
  // addresses threads by that id, and a Map (unlike the previous WeakMap on the
  // thread object) is what lets an update find the thread from the id alone.
  // A thread reloaded from the sidecar (US-23.5) is keyed by its durable comment
  // id instead — the two key spaces cannot collide, since a webview threadId
  // always contains '#' (`${docUri}#${salt}-${seq}`) and a uuid never does.
  const threads = new Map<string, ThreadEntry>();
  // Registry keys grouped by document, so a lifecycle op (reload after a rename,
  // document close) can find and drop exactly one document's threads. Without
  // this the flat map above could only ever grow, and a uuid already present from
  // the PRE-rename load would make the post-rename reload skip every thread —
  // i.e. the renamed file would show no comments at all.
  const byDoc = new Map<string, Set<string>>();
  // threadIds reserved while their sidecar write is in flight — the `has` check
  // below runs before an await, so without this two racing creates for one
  // threadId could both pass it.
  const creating = new Set<string>();
  // US-23.11 AC7: threadIds whose status transition is in flight. Same reason as
  // `creating` — the status check runs before an await, so without this a
  // double-click, or the popover and the native menu fired back to back, would
  // both pass it and append two lines for one intended transition.
  const changingStatus = new Set<string>();
  // Req 24 US-23.8 AC3(ii)/(iii): threadIds with a reply write in flight. Same
  // shape and reason as `creating`/`changingStatus` — the check below runs
  // before the `authorFor` await, so a webview retry racing the native
  // `orcaEditor.replyComment` command (which calls `reply` directly, with no
  // dedup of its own) can't both pass it. A separate Set, not shared with the
  // other two: a create or a status change in flight for a thread must never
  // block (or be released by) a reply to it, and vice versa.
  const replying = new Set<string>();
  // US-23.14 AC6: durable ids (comment or reply) whose `edit` append is in
  // flight. Keyed by the TARGET's own id — already a globally-unique uuid,
  // not by threadId — so an in-flight edit on one comment/reply can never
  // block or release a different one's edit (per-thread would be too coarse),
  // and per AC6's own sub-criterion, can never block or release an in-flight
  // reply either (that lives in the separate `replying` set).
  const editingTarget = new Set<string>();
  // US-23.13 AC1: threadIds whose anchor-update append is in flight. Same shape
  // and reason as `creating`/`changingStatus`/`replying` — a second re-attach
  // for the same thread while the first's append is still pending is a no-op
  // on the live thread, never a race between two `anchor-update` appends.
  const updatingAnchor = new Set<string>();
  // Documents whose sidecar has already been loaded, so a second panel on the
  // same file doesn't duplicate every thread.
  const loaded = new Set<string>();
  // US-23.9: per-document sidecar health, recorded by the load and read back by
  // every later snapshot. Kept beside `loaded` and cleared with it, so a retry
  // after a released claim reports the retry's outcome, not the failed attempt's.
  const sidecarState = new Map<string, CommentSidecarState>();

  /**
   * One document's identity for the registry. Folded on a case-insensitive
   * filesystem via the shared `sameDocumentUri` rule rather than compared raw, so
   * opening the same file through a differently-cased path is one document, not
   * two (CLAUDE.md's cross-platform trap).
   */
  const docKeyFor = (uri: vscode.Uri): string => {
    const raw = uri.toString();
    for (const existing of loaded) {
      if (sameDocumentUri(existing, raw, caseInsensitive)) {
        return existing;
      }
    }
    return raw;
  };

  /**
   * Whether `entryKey` is registered under `document`. `threads` is one global
   * map keyed by threadId, so a mutation path that only checks `msg.docUri`
   * against its own document has verified nothing about the ENTRY: a threadId
   * belonging to another file would append that file's line to this document's
   * sidecar and dispose the other document's live thread. Routed through
   * `docKeyFor` so the comparison folds case/NFC drift like the rest of the
   * registry (CLAUDE.md's cross-platform trap), never a raw string compare.
   */
  const ownedBy = (document: vscode.TextDocument, entryKey: string): boolean =>
    byDoc.get(docKeyFor(document.uri))?.has(entryKey) === true;

  const register = (docKey: string, entryKey: string, entry: ThreadEntry): void => {
    threads.set(entryKey, entry);
    const keys = byDoc.get(docKey);
    if (keys) {
      keys.add(entryKey);
    } else {
      byDoc.set(docKey, new Set([entryKey]));
    }
  };

  /**
   * US-23.10 AC4 (added during step-04 review): at most one author-name prompt
   * is ever open at a time — `webview.onDidReceiveMessage` does not await its
   * handlers and the native `vscode.comments` commands call `reply`/
   * `deleteComment`/`changeStatus` directly, so two actions can race into
   * `promptForAuthorName` together. `showInputBox` only allows one active quick
   * input; without this, the second caller's prompt would never show and it
   * would resolve `undefined` — refusing with "no author name was provided"
   * even though the user answered the first one. Every concurrent caller
   * instead awaits the SAME prompt and gets its answer.
   */
  let pendingAuthorPrompt: Promise<string> | undefined;

  /**
   * US-23.10 AC4: `os.userInfo()` cannot resolve a username (thrown, or an
   * empty string — seen in some containerized/CI environments with no
   * matching passwd entry) and no `authorName` setting is configured — prompt
   * for a name rather than proceed with an empty author. Returns `''` when the
   * user cancels, the sentinel every call site below checks: `resolveCommentAuthor`
   * never itself returns `''` for a non-empty answer, so this cannot collide
   * with a real name.
   */
  const promptForAuthorName = (document: vscode.TextDocument): Promise<string> => {
    if (pendingAuthorPrompt) {
      return pendingAuthorPrompt;
    }
    const promise = promptForAuthorNameOnce(document).finally(() => {
      pendingAuthorPrompt = undefined;
    });
    pendingAuthorPrompt = promise;
    return promise;
  };

  const promptForAuthorNameOnce = async (document: vscode.TextDocument): Promise<string> => {
    const answer = await vscode.window.showInputBox({
      title: 'Comment Author Name',
      prompt: 'No author name could be determined automatically — enter the name to record on this comment.',
      placeHolder: 'Your name',
      ignoreFocusOut: true,
      validateInput: (value) => authorNamePromptRejection(value) ?? null,
    });
    if (answer === undefined) {
      // Cancelled: the caller must stop this ONE action here, never proceed
      // with an empty name — the composer/reply box stays open with its
      // typed content intact (the webview treats this like any other refusal).
      return '';
    }
    const name = answer.trim().normalize('NFC');
    try {
      // Global, never Workspace: a workspace write would commit a personal
      // name into a shared repo, and `update(..., Workspace)` throws outright
      // with no folder open anyway.
      await vscode.workspace
        .getConfiguration('orcaEditor.comments', document.uri)
        .update('authorName', name, vscode.ConfigurationTarget.Global);
    } catch (err) {
      // Policy-locked settings.json, multi-root ambiguity... the answered name
      // still carries this ONE action through; only the persistence failed.
      log('Could not persist the comment author name to the Global settings', err);
      void vscode.window.showWarningMessage(
        `Could not save the author name to settings — using "${name}" for this action only.`
      );
    }
    return name;
  };

  /** The author name recorded on a new comment — re-read per create (the setting is live). */
  const authorFor = async (document: vscode.TextDocument): Promise<string> => {
    const configured = vscode.workspace.getConfiguration('orcaEditor.comments', document.uri).get<string>('authorName');
    const resolved = resolveCommentAuthor(configured, safeOsUsername());
    return resolved !== '' ? resolved : promptForAuthorName(document);
  };

  /** Req 24 US-23.18 AC9: the one refusal for "the document moved under this write" — stated, never silent. */
  const DOCUMENT_CHANGED_REFUSAL =
    'The document changed while your comment was being saved — please try again.';

  /**
   * US-23.19: never let a comment's `recorded_text` outlive the buffer it was
   * read from. Runs `store.refusalFor` first — the existing US-23.5 untitled/
   * virtual-scheme/outside-root refusals, unchanged and checked before this
   * gate ever reads `isDirty` (AC5) — then saves the document only when it is
   * actually dirty (AC3), with the append call itself the only thing a caller
   * runs after this resolves (AC1). `document.save()` writes only the user's
   * own already-pending edits, so it contributes no `TextEdit` of its own and
   * costs no extra undo step (AC4).
   *
   * Req 24 US-23.18 AC9: an undo/redo landing while a write is in flight changes
   * the document out from under data the caller already captured — every caller
   * reads its anchor, body and line off the inbound message up front and hands
   * them to `store.append` unchanged once this resolves, so the append would
   * record a `recorded_text` describing text the undo just removed.
   *
   * `versionAtEntry` is that capture point, and callers must read it at their
   * own first statement rather than letting this function sample it: `authorFor`
   * runs BEFORE this gate in every caller and can sit on a modal name prompt
   * (US-23.10 AC4) indefinitely, which is by far the widest part of the window.
   * Sampling here would leave exactly that part unguarded.
   *
   * The save is deliberately excluded from the comparison. A save participant
   * (format-on-save, trim-trailing-whitespace) edits the buffer during
   * `document.save()` and bumps `version` legitimately — treating that as a
   * conflict would refuse the FIRST comment action on any dirty buffer in such a
   * workspace, which is the common case, not an adversarial one. `isDirty` is
   * what separates the two afterwards: a participant's edit lands inside the
   * save and leaves the buffer clean, while an undo arriving during the save
   * makes it dirty again.
   */
  const saveBeforeAppend = async (
    document: vscode.TextDocument,
    versionAtEntry: number
  ): Promise<string | null> => {
    const refusal = await store.refusalFor(document);
    if (refusal !== null) {
      return refusal;
    }
    if (document.version !== versionAtEntry) {
      return DOCUMENT_CHANGED_REFUSAL;
    }
    if (document.isDirty) {
      if (!(await document.save())) {
        return 'Could not save the file before recording the comment.';
      }
      if (document.isDirty) {
        return DOCUMENT_CHANGED_REFUSAL;
      }
    }
    return null;
  };

  return {
    async createThread(msg, document): Promise<CreateThreadOutcome> {
      // Req 24 US-23.18 AC9: the write's payload is read from `msg` below and
      // handed to `store.append` unchanged; this is the version it is consistent
      // with, re-checked in `saveBeforeAppend` once every await in between is done.
      const versionAtEntry = document.version;
      const rejection = createCommentRejection(msg, document.uri.toString());
      if (rejection !== null) {
        return { ok: false, error: rejection };
      }
      if (threads.has(msg.threadId) || creating.has(msg.threadId)) {
        // One controller serves every document, so a colliding handle would
        // silently replace another thread's entry and misdirect its updates.
        return { ok: false, error: 'A comment thread with this id already exists.' };
      }
      const author = await authorFor(document);
      if (author === '') {
        // US-23.10 AC4: the author prompt was cancelled — cancel only this
        // create, same as any other refusal (the webview keeps the composer
        // open with its typed body intact).
        return { ok: false, error: 'No author name was provided — the comment was not created.' };
      }
      const createdAt = new Date();
      const timestamp = createdAt.toISOString();
      // US-23.5: persist first. The id written here is the thread's durable
      // handle — a reply or a tombstone names it, so it must not be the webview's
      // session-scoped threadId, which is reminted on every reopen.
      creating.add(msg.threadId);
      // Retained: a reply, a status change or a tombstone names this id, and it is
      // also what lets a later reload of this same document recognise the comment
      // instead of building a second thread for it.
      const commentId = crypto.randomUUID();
      let writeError: string | null;
      try {
        writeError = await saveBeforeAppend(document, versionAtEntry);
        if (writeError === null) {
          writeError = await store.append(
            document,
            buildCommentLine({
              id: commentId,
              author,
              timestamp,
              body: msg.body,
              anchor: {
                offset_start: msg.offsetStart,
                offset_end: msg.offsetEnd,
                recorded_text: msg.recordedText,
                last_known_line: msg.line,
                nearest_heading: msg.nearestHeading,
              },
            })
          );
        }
      } finally {
        creating.delete(msg.threadId);
      }
      if (writeError !== null) {
        // No native thread: a comment the sidecar never accepted would disappear
        // on the next reopen, which is worse than a reported failure.
        return { ok: false, error: writeError };
      }
      const line = commentThreadLine(msg.line);
      const range = new vscode.Range(line, 0, line, 0);
      const thread = controller.createCommentThread(document.uri, range, [
        asNativeComment({ author, timestamp, body: msg.body, threadId: msg.threadId, docUri: document.uri.toString() }),
      ]);
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      // A thread with no contextValue matches no `status-*` menu clause, so the
      // native UI would offer none of US-23.3's three actions on a thread created
      // this session — set both axes from the start, like every other path.
      applyThreadFacets(thread, 'exact', 'Open');
      register(docKeyFor(document.uri), msg.threadId, {
        thread,
        commentId,
        commentAuthor: author,
        commentBody: msg.body,
        commentTimestamp: timestamp,
        status: 'Open',
        statusChanges: [],
        replies: [],
        anchor: {
          anchorId: msg.anchorId,
          offsetStart: msg.offsetStart,
          offsetEnd: msg.offsetEnd,
          recordedText: msg.recordedText,
          lastKnownLine: msg.line,
          nearestHeading: msg.nearestHeading,
          state: 'exact',
        },
      });
      return { ok: true, author, timestamp };
    },

    async loadThreads(document): Promise<void> {
      const docKey = docKeyFor(document.uri);
      if (loaded.has(docKey)) {
        return;
      }
      // Claimed before the await so two panels opening at once can't both load.
      loaded.add(docKey);
      // Recorded BEFORE the first await, so a snapshot posted from the `ready`
      // handler while this read is in flight says "still loading" rather than
      // letting the webview conclude the file has no comments (US-23.9 AC12(d)).
      sidecarState.set(docKey, { loading: true });
      const refusal = await store.refusalFor(document);
      if (refusal !== null) {
        // No sidecar is possible at all. Recorded rather than logged, so the tab
        // shows the actionable reason instead of "No comments in this file".
        sidecarState.set(docKey, { problem: refusal });
        return;
      }
      let folded;
      try {
        // US-23.5 AC5: a sidecar whose name drifted out of VS Code (case, or
        // NFC vs NFD) is adopted before the read, so its comments are found
        // rather than silently treated as "this file has none".
        await store.adoptDrifted(document);
        folded = await store.load(document);
      } catch (err) {
        // Released, so reopening the file retries rather than leaving this
        // document permanently marked as loaded-with-nothing.
        loaded.delete(docKey);
        log(`Comment sidecar: loading ${document.uri.toString()} failed`, err);
        sidecarState.set(docKey, { problem: 'The comment sidecar could not be read. Reopen the file to retry.' });
        return;
      }
      if (folded.unreadable) {
        // The sidecar exists but could not be read (permissions, a directory in
        // the way, a transient network error). Presenting the file as having no
        // comments would be a lie the user cannot see, and appending onto it later
        // would mix new lines into history we never read — so release the claim so
        // a reopen retries, and say so out loud.
        loaded.delete(docKey);
        void vscode.window.showWarningMessage(
          'This file has comments, but the comment sidecar could not be read. Reopen the file to retry.'
        );
        sidecarState.set(docKey, {
          problem: 'This file has comments, but the comment sidecar could not be read. Reopen the file to retry.',
        });
        return;
      }
      // AC7 clause 2: a sidecar found beside a document it does not describe (the
      // `.md` was deleted and a new file created at the same path) must surface as
      // unresolved/floating, never silently reattached at its old line numbers.
      const belonging = sidecarBelongsToDocument(folded.threads, document.getText());
      const loadedState = belonging === 'foreign' ? 'floating' : 'approximate';
      if (belonging === 'foreign') {
        log(
          `Comment sidecar ${document.uri.toString()}: none of its ${folded.threads.length} recorded texts appear in this document — threads loaded as unresolved`
        );
        void vscode.window.showWarningMessage(
          `${folded.threads.length} comment(s) were found for this file, but none of the text they were written against is still here. They are marked as unresolved rather than attached to the wrong place.`
        );
      }
      if (folded.orphans.length > 0) {
        // AC4 routes these here "instead of silently dropping"; US-23.9's tab is
        // where they become visible, so the lines travel with the snapshot too.
        log(
          `Comment sidecar ${document.uri.toString()}: ${folded.orphans.length} orphaned reply/status line(s) have no parent comment`
        );
      }
      sidecarState.set(docKey, {
        foreign: belonging === 'foreign' ? true : undefined,
        orphans: folded.orphans.map((line) => ({
          id: line.id,
          kind: line.type === 'reply' ? 'reply' : 'status-change',
          author: line.author,
          timestamp: line.timestamp,
          detail: line.type === 'reply' ? line.body : line.to_status,
        })),
      });
      // Dedup within THIS document only, keyed by the durable comment id, so a
      // reload after a rename still builds the threads (a flat "seen this uuid"
      // check would skip them all) and a thread created this session is not
      // duplicated by the reload that follows.
      const known = new Set<string>();
      for (const entryKey of byDoc.get(docKey) ?? []) {
        const existing = threads.get(entryKey)?.commentId;
        if (existing !== null && existing !== undefined) {
          known.add(existing);
        }
      }
      for (const persisted of folded.threads) {
        if (known.has(persisted.id)) {
          continue;
        }
        try {
          register(docKey, persisted.id, {
            thread: buildLoadedThread(controller, document, persisted, loadedState),
            commentId: persisted.id,
            commentAuthor: persisted.comment.author,
            commentBody: persisted.comment.body,
            commentTimestamp: persisted.comment.timestamp,
            commentEditedAt: persisted.comment.editedAt,
            status: persisted.status,
            // US-23.11 AC2: the whole trail has to survive the reload, so it comes
            // off the (timestamp-sorted, illegal-lines-already-skipped) status-change
            // lines rather than being remembered only by the session that wrote them.
            statusChanges: persisted.statusChanges.map((line) => ({
              toStatus: line.to_status,
              author: line.author,
              timestamp: line.timestamp,
            })),
            replies: persisted.replies.map((r) => ({
              id: r.id,
              author: r.author,
              timestamp: r.timestamp,
              body: r.body,
              editedAt: r.editedAt,
            })),
            anchor: {
              // A fresh parse mints fresh structural ids, so a reloaded thread has
              // no tier-1 anchor to name. An empty id marks it as "not tier-1".
              anchorId: '',
              // US-23.13 AC1/AC2: `persisted.anchor` is the loader's folded
              // position (the latest `anchor-update` line, if one exists) — NOT
              // `persisted.comment.anchor`, which is the immutable creation-time
              // snapshot. Reading the latter here would silently discard every
              // persisted re-attachment/auto-resolution on reload.
              offsetStart: persisted.anchor.offset_start,
              offsetEnd: persisted.anchor.offset_end,
              recordedText: persisted.anchor.recorded_text,
              lastKnownLine: persisted.anchor.last_known_line,
              nearestHeading: persisted.anchor.nearest_heading,
              // Placed from last_known_line, not from a resolved structural id —
              // AC3's "never silently indistinguishable from an exact anchor".
              state: loadedState,
            },
          });
        } catch (err) {
          // Inside the loop, so one unbuildable thread costs only itself: the
          // remaining threads still load, and the claim stays so a reopen does not
          // duplicate the ones that succeeded.
          log(`Comment sidecar: could not place thread ${persisted.id}`, err);
        }
      }
    },

    async revalidateAfterSave(document): Promise<void> {
      // US-23.10 AC7: a no-op for the common case (nothing was ever refused
      // for this document) — safe to call unconditionally on every save.
      const docKey = docKeyFor(document.uri);
      if (sidecarState.get(docKey)?.problem === undefined) {
        return;
      }
      // Release the claim so the retry below is a real reload, not the
      // idempotency guard's "already loaded" no-op — the same release-and-
      // retry shape `loadThreads` itself already uses for an unreadable sidecar.
      loaded.delete(docKey);
      await this.loadThreads(document);
    },

    forgetDocument(uri): void {
      // A renamed/closed document's threads are bound to a uri that no longer
      // resolves. Dropping them lets the reopened document rebuild from the moved
      // sidecar instead of showing every comment twice — once against the dead uri.
      const docKey = docKeyFor(uri);
      for (const entryKey of byDoc.get(docKey) ?? []) {
        const entry = threads.get(entryKey);
        try {
          entry?.thread.dispose();
        } catch {
          // Already disposed by VS Code — nothing to undo.
        }
        threads.delete(entryKey);
      }
      byDoc.delete(docKey);
      loaded.delete(docKey);
      sidecarState.delete(docKey);
    },

    async updateAnchor(msg, document): Promise<string | null> {
      // Req 24 US-23.18 AC9: the write's payload is read from `msg` below and
      // handed to `store.append` unchanged; this is the version it is consistent
      // with, re-checked in `saveBeforeAppend` once every await in between is done.
      const versionAtEntry = document.version;
      const rejection = anchorUpdateRejection(msg, document.uri.toString());
      if (rejection !== null) {
        return rejection;
      }
      const entry = threads.get(msg.threadId);
      if (!entry) {
        return 'This anchor update names a thread that no longer exists.';
      }
      if (entry.thread.uri.toString() !== msg.docUri) {
        // Belt and braces behind the unique handle: never let one document's
        // resolution move a thread that lives in another file.
        return 'This anchor update names a thread in another document.';
      }
      if (msg.origin !== undefined && updatingAnchor.has(msg.threadId)) {
        // AC1: a re-attach for this thread while a PREVIOUS RE-ATTACH's append
        // is still in flight is a no-op — mirrors `changingStatus`'s guard
        // shape, never racing two `anchor-update` appends for one thread.
        // Scoped to `msg.origin !== undefined` so an ordinary in-memory-only
        // relocation (no persist attempted either way) is never blocked by an
        // unrelated persist that merely happens to be in flight for this same
        // thread — only a SECOND persist-worthy update races the first.
        return "This comment thread's anchor is already being updated.";
      }
      // A floating thread keeps its last known line, which can sit past the end
      // of a document that has since been cut down.
      const line = Math.min(commentThreadLine(msg.line), Math.max(0, document.lineCount - 1));
      try {
        entry.thread.range = new vscode.Range(line, 0, line, 0);
        // The native surface has no notion of anchor drift, so the state is
        // carried as a contextValue (available to menu `when` clauses) plus a
        // label — AC3's "never silently indistinguishable from an exact anchor"
        // has to hold here too, not only in the webview. The status half is
        // re-stamped with it so an anchor move never erases US-23.3's own gate.
        applyThreadFacets(entry.thread, msg.state, entry.status);
      } catch {
        // The thread was disposed (the user deleted it in the Comments panel, or
        // the controller tore it down). Forget it rather than throwing out of the
        // message handler on every later pass.
        threads.delete(msg.threadId);
        return 'This anchor update names a thread that no longer exists.';
      }
      entry.anchor.anchorId = msg.anchorId;
      entry.anchor.lastKnownLine = msg.line;
      entry.anchor.state = msg.state;

      if (msg.origin === undefined) {
        // An ordinary in-memory-only relocation, unchanged from before this AC
        // — nothing to persist.
        return null;
      }
      if (entry.commentId === null) {
        // Mirrors `reply`/`changeStatus`: a thread whose sidecar write is still
        // in flight has no durable id an `anchor-update` line could reference
        // yet. Reported rather than silently treated as already-persisted — the
        // live in-memory move above still applies either way.
        return 'This comment thread has no durable id yet — try again in a moment.';
      }
      updatingAnchor.add(msg.threadId);
      try {
        const author = await authorFor(document);
        const writeError =
          (await saveBeforeAppend(document, versionAtEntry)) ??
          (await store.append(
            document,
            buildAnchorUpdateLine({
              id: crypto.randomUUID(),
              parentCommentId: entry.commentId,
              author,
              timestamp: new Date().toISOString(),
              origin: msg.origin,
              anchor: {
                offset_start: msg.offsetStart,
                offset_end: msg.offsetEnd,
                recorded_text: msg.recordedText,
                last_known_line: msg.line,
                nearest_heading: msg.nearestHeading,
              },
            })
          ));
        return writeError;
      } catch (err) {
        // Same "report, don't swallow" contract as `changeStatus`: a throw here
        // must not skip `commentAnchorUpdateResult` and leave the caller with no
        // way to retry.
        log('updateAnchor persist failed', err);
        return 'This anchor could not be saved.';
      } finally {
        updatingAnchor.delete(msg.threadId);
      }
    },

    async reply(msg, document) {
      // Req 24 US-23.18 AC9: the write's payload is read from `msg` below and
      // handed to `store.append` unchanged; this is the version it is consistent
      // with, re-checked in `saveBeforeAppend` once every await in between is done.
      const versionAtEntry = document.version;
      const entry = threads.get(msg.threadId);
      const rejection = replyRejection(msg, document.uri.toString(), entry?.status);
      if (rejection !== null) {
        return { ok: false, error: rejection };
      }
      if (entry !== undefined && !ownedBy(document, msg.threadId)) {
        return { ok: false, error: 'This reply names a thread in another document.' };
      }
      if (!entry || entry.commentId === null) {
        // A thread whose sidecar write is somehow still in flight (or was
        // never durable) has no id a reply line could reference.
        return { ok: false, error: 'This comment thread has no durable id yet — try again in a moment.' };
      }
      if (replying.has(msg.threadId)) {
        // AC3(ii): covers BOTH the webview's own retry (its `inFlightReplyRequest`
        // guard) and the native `orcaEditor.replyComment` command, which calls
        // this function directly with no dedup of its own (hardcoded requestId
        // 0). The check runs before the `authorFor` await below, so two
        // concurrent replies for this thread can't both pass it.
        return { ok: false, error: 'A reply to this thread is already being submitted.' };
      }
      replying.add(msg.threadId);
      try {
        const author = await authorFor(document);
        if (author === '') {
          // US-23.10 AC4: cancelled prompt — cancel only this reply, leaving the
          // reply box open with its typed text intact (same as any other refusal).
          return { ok: false, error: 'No author name was provided — the reply was not saved.' };
        }
        const createdAt = new Date();
        const timestamp = createdAt.toISOString();
        const replyId = crypto.randomUUID();
        const saveError = await saveBeforeAppend(document, versionAtEntry);
        const writeError =
          saveError ??
          (await store.append(
            document,
            buildReplyLine({ id: replyId, parentCommentId: entry.commentId, author, timestamp, body: msg.body })
          ));
        if (writeError !== null) {
          return { ok: false, error: writeError };
        }
        entry.replies.push({ id: replyId, author, timestamp, body: msg.body });
        try {
          entry.thread.comments = nativeCommentsFor(entry, msg.threadId, document.uri.toString());
        } catch {
          // Thread disposed concurrently (deleted from the native UI mid-reply) —
          // the sidecar line is already durable and reassembles correctly on the
          // next reload; nothing more to reconcile on this live object.
        }
        return { ok: true, replyId, author, timestamp };
      } finally {
        replying.delete(msg.threadId);
      }
    },

    async deleteComment(msg, document) {
      // Req 24 US-23.18 AC9: the write's payload is read from `msg` below and
      // handed to `store.append` unchanged; this is the version it is consistent
      // with, re-checked in `saveBeforeAppend` once every await in between is done.
      const versionAtEntry = document.version;
      const entry = threads.get(msg.threadId);
      const currentAuthor = await authorFor(document);
      if (currentAuthor === '') {
        // US-23.10 AC4: cancelled prompt — cancel only this delete.
        return { ok: false, error: 'No author name was provided — nothing was deleted.' };
      }
      const target =
        entry === undefined
          ? undefined
          : msg.targetReplyId !== undefined
            ? entry.replies.find((r) => r.id === msg.targetReplyId)
            : entry.commentId !== null
              ? { id: entry.commentId, author: entry.commentAuthor }
              : undefined;
      const rejection = deleteRejection(msg, document.uri.toString(), target, currentAuthor);
      if (rejection !== null || !entry || !target) {
        return { ok: false, error: rejection ?? 'That comment or reply no longer exists.' };
      }
      if (!ownedBy(document, msg.threadId)) {
        return { ok: false, error: 'That delete names a thread in another document.' };
      }
      const timestamp = new Date().toISOString();
      const saveError = await saveBeforeAppend(document, versionAtEntry);
      const writeError =
        saveError ??
        (await store.append(
          document,
          buildDeleteLine({ id: crypto.randomUUID(), targetId: target.id, author: currentAuthor, timestamp })
        ));
      if (writeError !== null) {
        return { ok: false, error: writeError };
      }
      if (msg.targetReplyId !== undefined) {
        // Cascades to this ONE reply only — the thread and its other replies
        // are untouched (US-23.2 PO decision).
        entry.replies = entry.replies.filter((r) => r.id !== msg.targetReplyId);
        try {
          entry.thread.comments = nativeCommentsFor(entry, msg.threadId, document.uri.toString());
        } catch {
          // Disposed concurrently — nothing left to reconcile live.
        }
      } else {
        // Deleting the thread cascades to every reply under it in one action.
        try {
          entry.thread.dispose();
        } catch {
          // Already disposed.
        }
        threads.delete(msg.threadId);
        byDoc.get(docKeyFor(document.uri))?.delete(msg.threadId);
      }
      return { ok: true };
    },

    async editComment(msg, document) {
      // Req 24 US-23.18 AC9: the write's payload is read from `msg` below and
      // handed to `store.append` unchanged; this is the version it is consistent
      // with, re-checked in `saveBeforeAppend` once every await in between is done.
      const versionAtEntry = document.version;
      // US-23.10 AC9, applied at the WRITE path rather than only in the webview:
      // the native `vscode.comments` Save reaches this function without ever
      // passing through the popover's own neutralize/EOL step, and AC8 lets any
      // user edit any comment — so an unstripped bidi override from that surface
      // would reorder another user's rendered comment for every reader. Applied
      // before validation so the length check and the unchanged-text comparison
      // both measure exactly what would be written. Idempotent for the webview
      // path, which already normalized.
      const body = typeof msg.body === 'string' ? neutralizeCommentBody(normalizeCommentBodyEol(msg.body)) : msg.body;
      const entry = threads.get(msg.threadId);
      if (!entry) {
        return { ok: false, error: 'This comment thread no longer exists.' };
      }
      if (!ownedBy(document, msg.threadId)) {
        return { ok: false, error: 'This edit names a thread in another document.' };
      }
      if (entry.commentId === null) {
        // A thread whose sidecar write is still in flight has no durable id an
        // `edit` line could reference yet.
        return { ok: false, error: 'This comment thread has no durable id yet — try again in a moment.' };
      }
      const target =
        msg.targetReplyId !== undefined
          ? entry.replies.find((r) => r.id === msg.targetReplyId)
          : { id: entry.commentId, body: entry.commentBody };
      if (!target) {
        return { ok: false, error: 'That comment or reply no longer exists.' };
      }
      // Validated only once the target is known, so the length bound can be
      // measured against the body actually being replaced (see `editRejection`'s
      // `originalBody`).
      const rejection = editRejection({ ...msg, body }, document.uri.toString(), entry.status, target.body);
      if (rejection !== null) {
        return { ok: false, error: rejection };
      }
      // AC2's sub-criterion: unchanged (trimmed) text is Cancel, not an edit —
      // no line appended, no "edited" marker newly set.
      if (body.trim() === target.body.trim()) {
        return { ok: true };
      }
      if (editingTarget.has(target.id)) {
        // AC6, keyed per TARGET (this comment or this one reply) rather than
        // per thread: an in-flight edit on a DIFFERENT comment/reply of the
        // same thread must never be blocked or released by this guard, and
        // (AC6's own sub-criterion) neither must an in-flight reply — that
        // lives in the separate `replying` set.
        return { ok: false, error: 'An edit to this comment is already being saved.' };
      }
      // Claimed BEFORE the first await, exactly like `creating`/`replying`/
      // `changingStatus`: `authorFor` can block indefinitely on US-23.10 AC4's
      // name prompt, so a check-then-act with the claim after it would let two
      // requests for one target (the webview path racing the native
      // `orcaEditor.saveEditComment`, or two panels on one document) both pass
      // the `has` check and append two `edit` lines for one intended edit.
      editingTarget.add(target.id);
      try {
        const currentAuthor = await authorFor(document);
        if (currentAuthor === '') {
          // US-23.10 AC4: cancelled prompt — cancel only this edit.
          return { ok: false, error: 'No author name was provided — the edit was not saved.' };
        }
        const timestamp = new Date().toISOString();
        const saveError = await saveBeforeAppend(document, versionAtEntry);
        if (saveError !== null) {
          return { ok: false, error: saveError };
        }
        // AC1's sub-criterion requires that NO `edit` line be appended for a
        // target that vanished, so the race is re-checked on the near side of
        // the append — `authorFor` (which can sit on a name prompt) and
        // `saveBeforeAppend` are both awaits a concurrent delete or Close can
        // land inside. `entry` is the SAME object `deleteComment`/`changeStatus`
        // mutate in place, so re-reading it here sees that.
        const stillWritable =
          threads.get(msg.threadId) === entry &&
          entry.status !== 'Closed' &&
          (msg.targetReplyId === undefined || entry.replies.some((r) => r.id === msg.targetReplyId));
        if (!stillWritable) {
          return {
            ok: false,
            error:
              entry.status === 'Closed'
                ? 'This thread is closed — reopen it before editing.'
                : 'This comment was deleted.',
          };
        }
        const writeError = await store.append(
          document,
          buildEditLine({ id: crypto.randomUUID(), targetId: target.id, author: currentAuthor, timestamp, body })
        );
        if (writeError !== null) {
          return { ok: false, error: writeError };
        }
        // Re-checked once more on the far side: the append itself is an await,
        // and a delete landing inside it leaves a stray `edit` line that AC5's
        // idempotent-no-op fold discards on load — but the live in-memory copy
        // must not be updated as though the edit had taken.
        const targetStillLive =
          threads.get(msg.threadId) === entry &&
          (msg.targetReplyId === undefined || entry.replies.some((r) => r.id === msg.targetReplyId));
        if (!targetStillLive) {
          return { ok: false, error: 'This comment was deleted.' };
        }
        if (msg.targetReplyId !== undefined) {
          const reply = entry.replies.find((r) => r.id === msg.targetReplyId);
          if (reply) {
            reply.body = body;
            reply.editedAt = timestamp;
          }
        } else {
          entry.commentBody = body;
          entry.commentEditedAt = timestamp;
        }
        try {
          entry.thread.comments = nativeCommentsFor(entry, msg.threadId, document.uri.toString());
        } catch {
          // Disposed concurrently — the sidecar line is already durable and
          // folds correctly on the next reload; nothing more to reconcile live.
        }
        return { ok: true };
      } catch (err) {
        // Same "report, don't swallow" contract as `changeStatus`: a throw here
        // must not skip `editCommentResult` and leave the caller's guard armed
        // for the rest of the session.
        log('editComment failed', err);
        return { ok: false, error: 'That edit could not be saved.' };
      } finally {
        editingTarget.delete(target.id);
      }
    },

    setEditingMode(threadId, replyId, editing): boolean {
      const entry = threads.get(threadId);
      if (!entry) {
        return false;
      }
      const reply = replyId !== undefined ? entry.replies.find((r) => r.id === replyId) : undefined;
      if (replyId !== undefined && reply === undefined) {
        return false;
      }
      // The registry's body, never the `Comment` object's own — VS Code mutates
      // that in place with the user's in-progress text while the native field is
      // open, so spreading it forward would leave Cancel rendering the abandoned
      // text in Preview mode over a sidecar that never received it. Re-stamping
      // the authoritative body is what makes Cancel a real discard (AC1).
      const authoritativeBody = reply !== undefined ? reply.body : entry.commentBody;
      try {
        entry.thread.comments = entry.thread.comments.map((c) => {
          const oc = c as EditableComment;
          if (oc.orcaThreadId !== threadId || oc.orcaReplyId !== replyId) {
            return c;
          }
          return {
            ...oc,
            body: authoritativeBody,
            mode: editing ? vscode.CommentMode.Editing : vscode.CommentMode.Preview,
          };
        });
        return true;
      } catch {
        // Disposed concurrently — nothing left to toggle live.
        return false;
      }
    },

    async changeStatus(msg, document) {
      // Req 24 US-23.18 AC9: the write's payload is read from `msg` below and
      // handed to `store.append` unchanged; this is the version it is consistent
      // with, re-checked in `saveBeforeAppend` once every await in between is done.
      const versionAtEntry = document.version;
      const entry = threads.get(msg.threadId);
      // US-23.11 AC5: validated against `entry.status` — the freshly-folded status
      // this registry holds — never against the `contextValue` the native menu was
      // built from, which may be several transitions stale by the time it is
      // clicked.
      const rejection = statusChangeRejection(msg, document.uri.toString(), entry?.status);
      if (rejection !== null || !entry) {
        return { ok: false, error: rejection ?? 'This comment thread no longer exists.' };
      }
      const currentAuthor = await authorFor(document);
      if (currentAuthor === '') {
        // US-23.10 AC4: cancelled prompt — cancel only this transition.
        return { ok: false, error: 'No author name was provided — the status was not changed.' };
      }
      if (changingStatus.has(msg.threadId)) {
        // US-23.11 AC7: a transition for this thread is already between its append
        // and the `entry.status` update below, so the status check above read a
        // value that is about to change. Mirrors the `creating` guard: the second
        // request is a no-op, not a second sidecar line.
        return { ok: false, error: 'This comment is already being updated.' };
      }
      if (!ownedBy(document, msg.threadId)) {
        // Same guard `reply`/`deleteComment` carry: `threads` is one global map,
        // so a threadId from another file would append this transition to the
        // wrong sidecar and move the wrong document's thread.
        return { ok: false, error: 'This status change names a thread in another document.' };
      }
      if (entry.commentId === null) {
        // A thread whose sidecar write is still in flight has no durable id a
        // `status-change` line could name as its parent.
        return { ok: false, error: 'This comment thread has no durable id yet — try again in a moment.' };
      }
      const fromStatus = entry.status;
      const toStatus = STATUS_CHANGE_TARGET[msg.action];
      const timestamp = new Date().toISOString();
      // Held across the append AND the registry update, so the window a second
      // request could read a stale `entry.status` in is closed at both ends.
      changingStatus.add(msg.threadId);
      try {
        const saveError = await saveBeforeAppend(document, versionAtEntry);
        const writeError =
          saveError ??
          (await store.append(
            document,
            buildStatusChangeLine({
              id: crypto.randomUUID(),
              parentCommentId: entry.commentId,
              author: currentAuthor,
              timestamp,
              fromStatus,
              toStatus,
            })
          ));
        if (writeError !== null) {
          // Persist-then-apply, like every other action: a transition the sidecar
          // never accepted must not be shown as taken, since it would vanish on
          // the next reopen. US-23.11 AC8: the reason travels back through the same
          // `changeCommentStatusResult` channel create/reply use, and the thread
          // stays at `fromStatus` so the control is live again for a retry.
          return { ok: false, error: writeError };
        }
        entry.status = toStatus;
        entry.statusChanges.push({ toStatus, author: currentAuthor, timestamp });
        try {
          applyThreadFacets(entry.thread, entry.anchor.state, toStatus);
        } catch {
          // Disposed concurrently (deleted from the native UI mid-transition) — the
          // sidecar line is already durable and folds correctly on the next reload.
        }
        return { ok: true, status: toStatus, author: currentAuthor, timestamp };
      } catch (err) {
        // US-23.8 AC8 forbids "a silent no-op that leaves the user clicking a
        // live-looking button". `store.append` catches its own I/O errors, but the
        // scheme/guard checks around it run outside that catch — letting one throw
        // past here would skip `changeCommentStatusResult` entirely, and the
        // webview's single in-flight slot would never be released, silently
        // deadening every later status action for the session.
        log('changeStatus failed', err);
        return { ok: false, error: 'That comment could not be updated.' };
      } finally {
        changingStatus.delete(msg.threadId);
      }
    },

    sidecarStateFor(document): CommentSidecarState | undefined {
      return sidecarState.get(docKeyFor(document.uri));
    },

    listThreads(document): CommentSyncThread[] {
      const docKey = docKeyFor(document.uri);
      const result: CommentSyncThread[] = [];
      for (const entryKey of byDoc.get(docKey) ?? []) {
        const entry = threads.get(entryKey);
        if (!entry) {
          continue;
        }
        result.push({
          threadId: entryKey,
          status: entry.status,
          author: entry.commentAuthor,
          timestamp: entry.commentTimestamp,
          body: entry.commentBody,
          editedAt: entry.commentEditedAt,
          recordedText: entry.anchor.recordedText,
          offsetStart: entry.anchor.offsetStart,
          offsetEnd: entry.anchor.offsetEnd,
          lastKnownLine: entry.anchor.lastKnownLine,
          nearestHeading: entry.anchor.nearestHeading,
          replies: entry.replies.map((r) => ({
            id: r.id,
            author: r.author,
            timestamp: r.timestamp,
            body: r.body,
            editedAt: r.editedAt,
          })),
          statusChanges: entry.statusChanges.map((t) => ({ ...t })),
        });
      }
      // Oldest-created first — the same order `foldSidecarRecords` reassembles threads in.
      result.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      return result;
    },

    anchorOf(threadId): CommentAnchor | undefined {
      return threads.get(threadId)?.anchor;
    },

    threadIdFor(thread): string | undefined {
      for (const [key, entry] of threads) {
        if (entry.thread === thread) {
          return key;
        }
      }
      return undefined;
    },
    dispose(): void {
      threads.clear();
      byDoc.clear();
      loaded.clear();
      sidecarState.clear();
      creating.clear();
      changingStatus.clear();
      editingTarget.clear();
      // Disposing the controller disposes every thread it created.
      controller.dispose();
    },
  };
}
