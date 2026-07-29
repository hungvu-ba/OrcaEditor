/**
 * Req 23 US-23.5: reading and writing the per-file `.orca-comments.jsonl`
 * sidecar — the one owner of every sidecar path and byte, so no caller
 * hand-rolls a path derivation or a comparison.
 *
 * Writes are a single `fs.appendFile` of one whole line for `append` (US-23.6's
 * PO decision — used by `reply`/`editComment`/`changeStatus`/`anchor-update`),
 * never a read-modify-rewrite: an interrupted write can at most leave one
 * truncated final line, which `parseSidecarText` already tolerates, whereas a
 * full rewrite could clobber a concurrent writer's line entirely.
 *
 * `removeComment` is a deliberate, scoped exception to that append-only rule —
 * NOT an oversight of it. Delete now physically rewrites (or removes) the
 * sidecar instead of appending a `delete` tombstone, so the file stops growing
 * forever and a fully-deleted file no longer trips the misleading "you will
 * lose your comments" gitignore warning (`Local Test/bug_Comment.md` Bug #1;
 * `_bmad-output/quick-dev/inprogress-comment-delete-sidecar-rewrite.md`). It
 * narrows the reopened race back down by re-reading immediately before
 * writing and failing rather than silently clobbering a concurrent append —
 * see its own doc comment below.
 *
 * `node:fs` rather than `vscode.workspace.fs` because the latter has no append
 * API and a whole-file `writeFile` is exactly the read-modify-write this design
 * rejects. The cost is that a non-`file` scheme (virtual/remote FS) has no
 * sidecar — guarded up front with a specific message, the same way
 * `savePastedImage` bails on an untitled document (X-20).
 *
 * Nothing here touches the `.md`: a comment action must never occupy a slot in
 * the document's undo stack (US-23.6).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  foldSidecarRecords,
  isSidecarName,
  mdNameForSidecar,
  parseSidecarText,
  pruneDeadSidecarLines,
  removeSidecarLineCascade,
  serializeSidecarLine,
  sidecarBackupNameFor,
  sidecarNameFor,
  sidecarNameMatches,
  type FoldedSidecar,
  type SidecarLine,
} from './sidecar-format';

/**
 * Whether the sidecar may be written at `target` for `document`. Injected rather
 * than imported so this module doesn't reach back into the provider: every
 * webview-originated write goes through the provider's existing
 * `isInsideAllowedRoots` gate, since a `createComment` payload is untrusted input.
 */
export type SidecarWriteGuard = (docUri: vscode.Uri, target: vscode.Uri) => Promise<boolean>;

/**
 * Injectable seams for behaviour a host test needs to control without a real
 * modal or a real filesystem permission error (US-23.17 AC6/AC9): both default
 * to the real implementation, so the one production call site never has to pass
 * this at all.
 */
export interface SidecarStoreDeps {
  /** Defaults to a real `vscode.window.showWarningMessage` modal (AC6). */
  confirmOverwrite?: (message: string) => Promise<boolean>;
  /**
   * Defaults to `fs.promises` (AC9). `writeFile`/`unlink` were added alongside
   * `removeComment` — the temp-file-then-`rename` rewrite and the
   * zero-threads-left file deletion both need them. `readFile` was added so a
   * host test can inject a stub that changes bytes between `removeComment`'s
   * two internal reads, to exercise the concurrent-write-lands-in-between
   * branch without a real timing race.
   */
  fsOps?: Pick<typeof fs.promises, 'appendFile' | 'rename' | 'writeFile' | 'unlink' | 'readFile'>;
}

export interface SidecarStore {
  /** The sidecar's location for a document — its 1:1 sibling (AC1). */
  uriFor(document: vscode.TextDocument): vscode.Uri;
  /**
   * Append one line. Resolves to the reason it could not be written, or null on
   * success. A failure is always reported, never swallowed (US-23.6 AC5).
   */
  append(document: vscode.TextDocument, line: SidecarLine): Promise<string | null>;
  /**
   * Physically removes `targetId`'s line (and its cascade — see
   * `removeSidecarLineCascade`) from the sidecar, instead of appending a
   * `delete` tombstone. Deletes the `.jsonl` file itself when that rewrite
   * leaves no lines at all — i.e. this was the only thread on record —
   * rather than leaving an empty file behind. Reads the file's current bytes
   * fresh immediately before computing what to keep, then re-reads
   * immediately before writing to catch a concurrent append landing in
   * between — that case fails with a retryable error rather than silently
   * overwriting the concurrent line. Resolves to the reason it could not be
   * applied, or null on success, matching `append`'s contract (never
   * throws).
   */
  removeComment(document: vscode.TextDocument, targetId: string): Promise<string | null>;
  /**
   * Every thread persisted for a document, reassembled per AC4. An absent
   * sidecar is not an error — it is a document nobody has commented on yet.
   */
  load(document: vscode.TextDocument): Promise<FoldedSidecar>;
  /**
   * AC5: add the file operation that moves a `.md`'s sidecar along with it to the
   * caller's `WorkspaceEdit`, so VS Code applies both renames as ONE operation.
   * Adds nothing when there is no sidecar, or when the user declined to overwrite
   * one already at the destination.
   */
  planRename(edit: vscode.WorkspaceEdit, oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void>;
  /**
   * AC5: adopt a sidecar whose on-disk name differs from the derived one only by
   * Unicode normalization form or case — the out-of-VS-Code drift a rename event
   * never reports. No-op when the exact name already exists.
   */
  adoptDrifted(document: vscode.TextDocument): Promise<void>;
  /**
   * Why this document can hold no sidecar at all (untitled, a non-`file`
   * scheme, or a saved document whose sidecar sibling would land outside the
   * allowed workspace roots — US-23.10 AC7 added this third case, previously
   * only discoverable by actually calling `append`), or null when it can.
   * US-23.9 shows this instead of "no comments": the two look identical in an
   * empty list, and only one of them is fixable. Async because the third case
   * needs the same `guard` check `append` makes.
   */
  refusalFor(document: vscode.TextDocument): Promise<string | null>;
}

const EMPTY_SIDECAR: FoldedSidecar = { threads: [], orphans: [], warnings: [] };

/** True when a rejected read/write is just "no sidecar exists yet". */
function isMissingFile(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export function createSidecarStore(
  guard: SidecarWriteGuard,
  log: (message: string, err?: unknown) => void,
  /**
   * Whether this filesystem folds case. Passed in rather than read here: the
   * provider owns that flag (`CASE_INSENSITIVE_FS`), and every `text-utils`
   * helper in this codebase takes it as a trailing argument the same way.
   */
  caseInsensitive: boolean,
  deps: SidecarStoreDeps = {}
): SidecarStore {
  const fsOps = deps.fsOps ?? fs.promises;
  const confirmOverwrite =
    deps.confirmOverwrite ??
    (async (message: string): Promise<boolean> => {
      const overwrite = 'Overwrite comments';
      return (await vscode.window.showWarningMessage(message, { modal: true }, overwrite)) === overwrite;
    });

  /** The sidecar file name for any `.md` uri (not just an open document's). */
  const nameForUri = (mdUri: vscode.Uri): string => sidecarNameFor(mdUri.path.split('/').pop() ?? '');

  /**
   * Sibling of the `.md`, in the same directory — never the `images/` asset
   * folder (AC1), which unrelated orphan-cleanup logic scans (US-8.7). Derived
   * from `Uri.path` (always `/`-separated) rather than `fsPath`, so the split is
   * the same on every platform.
   */
  const sidecarForUri = (mdUri: vscode.Uri): vscode.Uri =>
    vscode.Uri.joinPath(mdUri, '..', nameForUri(mdUri));

  const uriFor = (document: vscode.TextDocument): vscode.Uri => sidecarForUri(document.uri);

  /** Whether a path exists on disk. */
  const exists = async (uri: vscode.Uri): Promise<boolean> => {
    try {
      await fs.promises.access(uri.fsPath);
      return true;
    } catch {
      return false;
    }
  };

  /** The reason this document can have no sidecar at all, or null when it can. */
  const schemeRejection = (document: vscode.TextDocument): string | null => {
    if (document.isUntitled) {
      return 'Save the file first to comment on it.';
    }
    if (document.uri.scheme !== 'file') {
      // A saved file on a virtual/remote filesystem. Telling this user to "save
      // the file first" would be false and unactionable — they already did, and
      // no amount of saving changes the scheme.
      return 'Comments need a file on disk; this document is on a virtual filesystem.';
    }
    return null;
  };

  /** The reason `append` would refuse THIS document outright — shared by `append` and `refusalFor` so the two never disagree (US-23.10 AC7). */
  const outsideRootRejection = async (document: vscode.TextDocument): Promise<string | null> => {
    const rejection = schemeRejection(document);
    if (rejection !== null) {
      return rejection;
    }
    if (!(await guard(document.uri, uriFor(document)))) {
      return 'The comment sidecar would be written outside the allowed workspace.';
    }
    return null;
  };

  /**
   * `outsideRootRejection` plus its refusal-logging boilerplate — shared by
   * every write path (`append`, `removeComment`) so a new one never has to
   * re-copy the "was this refusal the outside-workspace one" check.
   */
  const checkWritable = async (document: vscode.TextDocument): Promise<string | null> => {
    const rejection = await outsideRootRejection(document);
    if (rejection !== null) {
      if (rejection === 'The comment sidecar would be written outside the allowed workspace.') {
        log(`Refused to write comment sidecar outside the allowed workspace: ${uriFor(document).toString()}`);
      }
      return rejection;
    }
    return null;
  };

  return {
    uriFor,

    refusalFor: outsideRootRejection,

    async append(document, line): Promise<string | null> {
      const rejection = await checkWritable(document);
      if (rejection !== null) {
        return rejection;
      }
      const target = uriFor(document);
      try {
        // Always prepend a newline (US-23.20 AC2) — no probe, no check-then-act.
        // A stray leading blank line costs nothing: `parseSidecarText` already
        // skips it, and the earlier "does the file already end with a newline"
        // read was the one real check-then-act race in this write path.
        await fsOps.appendFile(target.fsPath, '\n' + serializeSidecarLine(line), 'utf8');
      } catch (err) {
        log(`Failed to append to comment sidecar ${target.toString()}`, err);
        return 'Failed to save the comment.';
      }
      return null;
    },

    async removeComment(document, targetId): Promise<string | null> {
      const rejection = await checkWritable(document);
      if (rejection !== null) {
        return rejection;
      }
      const target = uriFor(document);
      /** The file's current text, or null when it does not exist. Never throws for ENOENT. */
      const readCurrent = async (): Promise<{ text: string | null } | { error: unknown }> => {
        try {
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          return { text: await fsOps.readFile(target.fsPath, 'utf8') };
        } catch (err) {
          if (isMissingFile(err)) {
            return { text: null };
          }
          return { error: err };
        }
      };

      // Read fresh, immediately before computing what to keep (I/O Matrix:
      // "read the sidecar's current bytes fresh"), never a cached/older copy.
      const before = await readCurrent();
      if ('error' in before) {
        log(`Failed to read comment sidecar ${target.toString()}`, before.error);
        return 'Failed to delete the comment.';
      }
      if (before.text === null) {
        // I/O Matrix: "Sidecar already gone" (a race with another delete) —
        // no-op success, there is nothing left to remove.
        return null;
      }
      const afterTarget = removeSidecarLineCascade(parseSidecarText(before.text).lines, targetId);
      // Patch 2: since this delete already reads+parses+rewrites the whole
      // file, also garbage-collect every line that's already dead under the
      // EXISTING fold semantics (a legacy `delete` tombstone, or a
      // comment/reply/status-change/anchor-update/edit line an existing
      // tombstone already resolves as deleted) — not just the target above —
      // so a file with pre-existing tombstone bloat shrinks on the next
      // unrelated delete instead of carrying that bloat forever.
      const remainingLines = pruneDeadSidecarLines(afterTarget);
      const remainingText = remainingLines.map(serializeSidecarLine).join('');
      // "Zero threads left" (the Approach) is exactly "no lines left" here: the
      // cascade above removes every line belonging to the deleted target, and
      // every OTHER thread's own lines are untouched — so nothing remains
      // unless nothing else was ever recorded.
      const isEmpty = remainingLines.length === 0;

      // Re-check immediately before writing (I/O Matrix: "detect via a fresh
      // re-read immediately before the write"): a concurrent append landing in
      // the window above must never be silently clobbered by this rewrite.
      const justBefore = await readCurrent();
      if ('error' in justBefore) {
        log(`Failed to re-read comment sidecar before delete ${target.toString()}`, justBefore.error);
        return 'Failed to delete the comment.';
      }
      if (justBefore.text !== before.text) {
        return 'The comment sidecar changed while this delete was being saved — please try again.';
      }

      try {
        if (isEmpty) {
          await fsOps.unlink(target.fsPath);
        } else {
          // Temp-file-then-rename: the closest available atomicity primitive
          // here, reusing the already-injectable `rename` (I/O Matrix's
          // non-empty rewrite row). Same directory as `target` so the rename
          // is a same-filesystem move, never a cross-device copy.
          const tempTarget = `${target.fsPath}.tmp-${crypto.randomUUID()}`;
          try {
            await fsOps.writeFile(tempTarget, remainingText, 'utf8');
            await fsOps.rename(tempTarget, target.fsPath);
          } catch (err) {
            // The rewrite itself already failed, so best-effort cleanup here
            // costs nothing further if it also fails.
            await fsOps.unlink(tempTarget).catch(() => undefined);
            throw err;
          }
        }
      } catch (err) {
        if (isEmpty && isMissingFile(err)) {
          // Raced with another session's delete of the same file — the file
          // is already gone, which is exactly what this branch wanted.
          return null;
        }
        log(`Failed to rewrite comment sidecar ${target.toString()}`, err);
        return 'Failed to delete the comment.';
      }
      return null;
    },

    async load(document): Promise<FoldedSidecar> {
      if (schemeRejection(document) !== null) {
        return EMPTY_SIDECAR;
      }
      const target = uriFor(document);
      let text: string;
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        text = await fs.promises.readFile(target.fsPath, 'utf8');
      } catch (err) {
        if (isMissingFile(err)) {
          // Nobody has commented on this file yet — not an error.
          return EMPTY_SIDECAR;
        }
        // Permission denied, a directory in the way, an I/O error. Flagged, not
        // just logged: returning a plain empty result here would tell the caller
        // "this file has no comments", which is exactly the silent data-hiding
        // the log line alone cannot prevent.
        log(`Failed to read comment sidecar ${target.toString()}`, err);
        return { ...EMPTY_SIDECAR, unreadable: true };
      }
      const parsed = parseSidecarText(text);
      const folded = foldSidecarRecords(parsed.lines);
      const warnings = [...parsed.warnings, ...folded.warnings];
      for (const warning of warnings) {
        log(`Comment sidecar ${target.toString()}: ${warning}`);
      }
      // US-23.15 AC4: `conflicted` travels with the fold — the caller has to be
      // able to say "this sidecar is mid-merge", which is not derivable from the
      // warning strings without re-parsing them.
      return { ...folded, warnings, conflicted: parsed.conflicted, conflictMarkers: parsed.conflictMarkers };
    },

    async planRename(edit, oldUri, newUri): Promise<void> {
      // Only `file:` documents ever get a sidecar, so nothing else can have one
      // to move.
      if (oldUri.scheme !== 'file' || newUri.scheme !== 'file') {
        return;
      }
      const source = sidecarForUri(oldUri);
      if (!(await exists(source))) {
        // Nothing has been commented on — including the "Save As" case, which
        // creates a new file with no sidecar to carry over (AC6).
        return;
      }
      const destination = sidecarForUri(newUri);
      const leaveInPlace = (reason: string): void => {
        // Never silent: the comments still exist, and the user has to be able to
        // find them under a name that no longer matches any `.md`.
        log(`Comment sidecar left at ${source.toString()} — ${reason}`);
        void vscode.window.showWarningMessage(
          `${reason} Its comments stayed behind as ${nameForUri(oldUri)}.`
        );
      };
      if (!(await guard(newUri, destination))) {
        leaveInPlace('The renamed file is outside the allowed workspace, so its comments were not moved.');
        return;
      }
      // A case-only rename (`foo.md` → `Foo.md`, the usual "fix the
      // capitalisation" gesture) points `destination` at the SAME directory entry
      // as `source` on a case-insensitive volume, so `exists(destination)` is
      // true and the collision check below would prompt about the very file being
      // renamed. Still contribute the rename — that is how the sidecar picks up
      // the new casing — just never call it a collision.
      const sameEntry = sidecarNameMatches(nameForUri(oldUri), nameForUri(newUri), caseInsensitive)
        && sidecarForUri(oldUri).path.slice(0, -nameForUri(oldUri).length)
           === sidecarForUri(newUri).path.slice(0, -nameForUri(newUri).length);
      if (!sameEntry && (await exists(destination))) {
        // A rename that would discard another file's whole comment history has to
        // ask first (AC5). Confirming displaces the existing sidecar to a
        // timestamped backup rather than deleting it (US-23.20 AC8) — the ISO
        // timestamp is de-colonised so the backup name is a valid Windows
        // filename too.
        const stamp = new Date().toISOString().replace(/:/g, '-');
        const backupName = sidecarBackupNameFor(nameForUri(newUri), stamp);
        const backup = vscode.Uri.joinPath(destination, '..', backupName);
        const accepted = await confirmOverwrite(
          `${nameForUri(newUri)} already has comments. Overwrite them with the comments from ${nameForUri(oldUri)}? The existing comments will be kept as ${backupName}.`
        );
        if (!accepted) {
          // Declining must not destroy either side. The `.md` rename is the
          // user's own gesture and proceeds; this contributes no file operation,
          // so the destination's comments survive untouched and the source's stay
          // on disk. Cancelling the whole rename would be nicer, but a rejected
          // `waitUntil` is NOT documented to cancel a file operation, so relying
          // on it would make the outcome version-dependent.
          leaveInPlace(`${nameForUri(newUri)} already had comments, which were kept.`);
          return;
        }
        // Queued ahead of the source→destination rename below so the same
        // atomic WorkspaceEdit displaces the existing sidecar first, then frees
        // `destination` for the incoming one (US-23.20 AC8).
        edit.renameFile(destination, backup);
      }
      // A file operation on the WorkspaceEdit the caller hands back to
      // `onWillRenameFiles`, so VS Code performs both renames as one operation —
      // if either half fails the whole rename fails, which is the atomic pair
      // AC5 asks for. This is a file rename, not a text edit, so it adds nothing
      // to the `.md`'s undo stack (US-23.6).
      edit.renameFile(source, destination, { overwrite: true });
    },

    async adoptDrifted(document): Promise<void> {
      if (schemeRejection(document) !== null) {
        return;
      }
      const target = uriFor(document);
      if (await exists(target)) {
        // Either the name matches exactly, or the filesystem already resolved
        // the difference for us — on a case-insensitive or normalization-
        // insensitive volume (typical macOS/Windows) `Foo.md…` and `foo.md…`
        // are the same entry, so there is nothing to adopt.
        return;
      }
      const expectedName = nameForUri(document.uri);
      const directory = vscode.Uri.joinPath(document.uri, '..');
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(directory);
      } catch {
        return;
      }
      // No raw `name !== expectedName` exclusion is needed: `exists(target)`
      // already returned false, so an entry under exactly that name cannot be
      // present — and a raw filename comparison is what CLAUDE.md forbids anyway.
      const nameMatches = entries
        // `FileType` is a BITMASK: a symlinked file reports `File | SymbolicLink`
        // (65), never `1`, so a raw `=== FileType.File` would skip a symlinked
        // sidecar entirely.
        .filter(([, type]) => (type & vscode.FileType.File) !== 0)
        .map(([name]) => name)
        .filter((name) => isSidecarName(name) && sidecarNameMatches(name, expectedName, caseInsensitive));
      // ONLY an orphaned sidecar may be adopted. Without this, two genuinely
      // distinct files whose names differ just by normalization form or case
      // (`Tài liệu.md` NFD vs NFC; `Foo.md` vs `foo.md` on a case-sensitive
      // volume) would let opening one STEAL the other's entire comment history —
      // an adopt is a destructive rename, so "probably the same file" is not good
      // enough. A candidate whose own `.md` is still on disk belongs to that file.
      const drifted: string[] = [];
      for (const name of nameMatches) {
        const pairedName = mdNameForSidecar(name);
        if (pairedName === null) {
          continue;
        }
        if (!(await exists(vscode.Uri.joinPath(directory, pairedName)))) {
          drifted.push(name);
        }
      }
      if (drifted.length === 0) {
        return;
      }
      if (drifted.length > 1) {
        // Two orphaned entries both normalizing to this name (only possible on a
        // byte-exact filesystem). Picking one would silently discard the other's
        // comments, so leave the choice to the user.
        log(
          `Comment sidecar: ${drifted.length} candidates match ${expectedName} (${drifted.join(', ')}) — none adopted`
        );
        return;
      }
      const source = vscode.Uri.joinPath(directory, drifted[0]);
      if (!(await guard(document.uri, target))) {
        return;
      }
      try {
        await fsOps.rename(source.fsPath, target.fsPath);
        log(`Comment sidecar: adopted ${drifted[0]} as ${expectedName} (name drift)`);
      } catch (err) {
        // Not fatal — `load` simply finds no sidecar and the file opens with no
        // comments, exactly as before this attempt.
        log(`Failed to adopt drifted comment sidecar ${source.toString()}`, err);
      }
    },
  };
}
