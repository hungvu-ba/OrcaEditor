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
import * as os from 'os';
import * as vscode from 'vscode';
import {
  anchorUpdateRejection,
  commentThreadLine,
  createCommentRejection,
  deleteRejection,
  replyRejection,
  resolveCommentAuthor,
  type AnchorUpdateMessage,
  type CreateCommentMessage,
  type DeleteCommentMessage,
  type ReplyMessage,
} from './comment-utils';
import { sameDocumentUri } from '../text-utils';
import {
  buildCommentLine,
  buildDeleteLine,
  buildReplyLine,
  sidecarBelongsToDocument,
  type CommentStatus,
  type SidecarThread,
} from './sidecar-format';
import type { SidecarStore } from './sidecar-store';
import type { CommentSyncThread } from '../shared/messages';

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
   * native Range and record the new state. Returns the rejection reason or null.
   * Never edits the document (US-23.6).
   */
  updateAnchor(msg: AnchorUpdateMessage, document: vscode.TextDocument): string | null;
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
   * US-23.2: the full live snapshot `syncThreadsToWebview` pushes — the bridge
   * that lets a thread the webview did not itself mint this session (loaded
   * from the sidecar, or reached from the native `vscode.comments` UI) still
   * get a gutter pin/highlight/popover.
   */
  listThreads(document: vscode.TextDocument): CommentSyncThread[];
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
 * One `comment`/`reply` line turned into a native `vscode.Comment`. Hoisted out
 * of `buildLoadedThread` (US-23.2) so `reply()`/`deleteComment()` build the
 * exact same shape when they rebuild a thread's live `comments[]`, instead of
 * a second copy of the timestamp-guard drifting from this one.
 */
function asNativeComment(source: { author: string; timestamp: string; body: string }): vscode.Comment {
  return {
    body: new vscode.MarkdownString(source.body),
    mode: vscode.CommentMode.Preview,
    author: { name: source.author },
    // An unparseable timestamp would make `new Date` Invalid Date, which VS Code
    // renders as garbage — drop it rather than show that.
    timestamp: Number.isNaN(Date.parse(source.timestamp)) ? undefined : new Date(source.timestamp),
  };
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
  // been cut down since the comment was written.
  const line = Math.min(
    commentThreadLine(persisted.comment.anchor.last_known_line),
    Math.max(0, document.lineCount - 1)
  );
  const thread = controller.createCommentThread(document.uri, new vscode.Range(line, 0, line, 0), [
    asNativeComment(persisted.comment),
    ...persisted.replies.map(asNativeComment),
  ]);
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
  // Placed from a recorded line, not a live structural id — marked on this surface
  // too (US-23.4 AC3), exactly as `updateAnchor` does.
  thread.contextValue = `anchor-${state}`;
  thread.label = ANCHOR_STATE_LABEL[state];
  // The folded Open/Resolved/Closed status (US-23.3) mapped onto the native
  // two-state axis: anything past Open reads as resolved here.
  thread.state =
    persisted.status === 'Open' ? vscode.CommentThreadState.Unresolved : vscode.CommentThreadState.Resolved;
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
  /** US-23.3's axis, folded from status-change lines (always 'Open' until that story ships). */
  status: CommentStatus;
  /** US-23.2: live reply list — each reply's own durable id is what a later single-reply delete names. */
  replies: Array<{ id: string; author: string; timestamp: string; body: string }>;
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
  // Documents whose sidecar has already been loaded, so a second panel on the
  // same file doesn't duplicate every thread.
  const loaded = new Set<string>();

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

  /** The author name recorded on a new comment — re-read per create (the setting is live). */
  const authorFor = (document: vscode.TextDocument): string =>
    resolveCommentAuthor(
      vscode.workspace.getConfiguration('orcaEditor.comments', document.uri).get<string>('authorName'),
      os.userInfo().username
    );

  return {
    async createThread(msg, document): Promise<CreateThreadOutcome> {
      const rejection = createCommentRejection(msg, document.uri.toString());
      if (rejection !== null) {
        return { ok: false, error: rejection };
      }
      if (threads.has(msg.threadId) || creating.has(msg.threadId)) {
        // One controller serves every document, so a colliding handle would
        // silently replace another thread's entry and misdirect its updates.
        return { ok: false, error: 'A comment thread with this id already exists.' };
      }
      const author = authorFor(document);
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
        asNativeComment({ author, timestamp, body: msg.body }),
      ]);
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      register(docKeyFor(document.uri), msg.threadId, {
        thread,
        commentId,
        commentAuthor: author,
        commentBody: msg.body,
        commentTimestamp: timestamp,
        status: 'Open',
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
        // AC4 routes these here "instead of silently dropping" — surfacing the
        // count is the least that makes them non-silent until US-23.7 lists them.
        log(
          `Comment sidecar ${document.uri.toString()}: ${folded.orphans.length} orphaned reply/status line(s) have no parent comment`
        );
      }
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
            status: persisted.status,
            replies: persisted.replies.map((r) => ({ id: r.id, author: r.author, timestamp: r.timestamp, body: r.body })),
            anchor: {
              // A fresh parse mints fresh structural ids, so a reloaded thread has
              // no tier-1 anchor to name. An empty id marks it as "not tier-1".
              anchorId: '',
              offsetStart: persisted.comment.anchor.offset_start,
              offsetEnd: persisted.comment.anchor.offset_end,
              recordedText: persisted.comment.anchor.recorded_text,
              lastKnownLine: persisted.comment.anchor.last_known_line,
              nearestHeading: persisted.comment.anchor.nearest_heading,
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
    },

    updateAnchor(msg, document): string | null {
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
      // A floating thread keeps its last known line, which can sit past the end
      // of a document that has since been cut down.
      const line = Math.min(commentThreadLine(msg.line), Math.max(0, document.lineCount - 1));
      try {
        entry.thread.range = new vscode.Range(line, 0, line, 0);
        // The native surface has no notion of anchor drift, so the state is
        // carried as a contextValue (available to menu `when` clauses) plus a
        // label — AC3's "never silently indistinguishable from an exact anchor"
        // has to hold here too, not only in the webview.
        entry.thread.contextValue = `anchor-${msg.state}`;
        entry.thread.label = msg.state === 'exact' ? undefined : ANCHOR_STATE_LABEL[msg.state];
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
      return null;
    },

    async reply(msg, document) {
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
      const author = authorFor(document);
      const createdAt = new Date();
      const timestamp = createdAt.toISOString();
      const replyId = crypto.randomUUID();
      const writeError = await store.append(
        document,
        buildReplyLine({ id: replyId, parentCommentId: entry.commentId, author, timestamp, body: msg.body })
      );
      if (writeError !== null) {
        return { ok: false, error: writeError };
      }
      entry.replies.push({ id: replyId, author, timestamp, body: msg.body });
      try {
        entry.thread.comments = [
          asNativeComment({ author: entry.commentAuthor, timestamp: entry.commentTimestamp, body: entry.commentBody }),
          ...entry.replies.map(asNativeComment),
        ];
      } catch {
        // Thread disposed concurrently (deleted from the native UI mid-reply) —
        // the sidecar line is already durable and reassembles correctly on the
        // next reload; nothing more to reconcile on this live object.
      }
      return { ok: true, replyId, author, timestamp };
    },

    async deleteComment(msg, document) {
      const entry = threads.get(msg.threadId);
      const currentAuthor = authorFor(document);
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
      const writeError = await store.append(
        document,
        buildDeleteLine({ id: crypto.randomUUID(), targetId: target.id, author: currentAuthor, timestamp })
      );
      if (writeError !== null) {
        return { ok: false, error: writeError };
      }
      if (msg.targetReplyId !== undefined) {
        // Cascades to this ONE reply only — the thread and its other replies
        // are untouched (US-23.2 PO decision).
        entry.replies = entry.replies.filter((r) => r.id !== msg.targetReplyId);
        try {
          entry.thread.comments = [
            asNativeComment({ author: entry.commentAuthor, timestamp: entry.commentTimestamp, body: entry.commentBody }),
            ...entry.replies.map(asNativeComment),
          ];
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
          recordedText: entry.anchor.recordedText,
          offsetStart: entry.anchor.offsetStart,
          offsetEnd: entry.anchor.offsetEnd,
          lastKnownLine: entry.anchor.lastKnownLine,
          nearestHeading: entry.anchor.nearestHeading,
          replies: entry.replies.map((r) => ({ id: r.id, author: r.author, timestamp: r.timestamp, body: r.body })),
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
      creating.clear();
      // Disposing the controller disposes every thread it created.
      controller.dispose();
    },
  };
}
