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
  resolveCommentAuthor,
  type AnchorUpdateMessage,
  type CreateCommentMessage,
} from './comment-utils';
import { sameDocumentUri } from '../text-utils';
import { buildCommentLine, sidecarBelongsToDocument, type SidecarThread } from './sidecar-format';
import type { SidecarStore } from './sidecar-store';

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
}

/** What a non-exact anchor reads as on the native thread (US-23.4 AC3/AC4). */
const ANCHOR_STATE_LABEL: Record<Exclude<AnchorUpdateMessage['state'], 'exact'>, string> = {
  approximate: 'Approximate location',
  floating: 'Unresolved location',
};

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
  const asComment = (source: { author: string; timestamp: string; body: string }): vscode.Comment => ({
    body: new vscode.MarkdownString(source.body),
    mode: vscode.CommentMode.Preview,
    author: { name: source.author },
    // An unparseable timestamp would make `new Date` Invalid Date, which VS Code
    // renders as garbage — drop it rather than show that.
    timestamp: Number.isNaN(Date.parse(source.timestamp)) ? undefined : new Date(source.timestamp),
  });
  // last_known_line is 1-based and can sit past the end of a document that has
  // been cut down since the comment was written.
  const line = Math.min(
    commentThreadLine(persisted.comment.anchor.last_known_line),
    Math.max(0, document.lineCount - 1)
  );
  const thread = controller.createCommentThread(document.uri, new vscode.Range(line, 0, line, 0), [
    asComment(persisted.comment),
    ...persisted.replies.map(asComment),
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
      const comment: vscode.Comment = {
        body: new vscode.MarkdownString(msg.body),
        mode: vscode.CommentMode.Preview,
        author: { name: author },
        timestamp: createdAt,
      };
      const thread = controller.createCommentThread(document.uri, range, [comment]);
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      register(docKeyFor(document.uri), msg.threadId, {
        thread,
        commentId,
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
    anchorOf(threadId): CommentAnchor | undefined {
      return threads.get(threadId)?.anchor;
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
