/**
 * Req 23 US-23.5: reading and writing the per-file `.orca-comments.jsonl`
 * sidecar — the one owner of every sidecar path and byte, so no caller
 * hand-rolls a path derivation or a comparison.
 *
 * Writes are a single `fs.appendFile` of one whole line (US-23.6's PO decision),
 * never a read-modify-rewrite: an interrupted write can at most leave one
 * truncated final line, which `parseSidecarText` already tolerates, whereas a
 * full rewrite could clobber a concurrent writer's line entirely.
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
import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  foldSidecarRecords,
  isSidecarName,
  mdNameForSidecar,
  parseSidecarText,
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
  /** Defaults to `fs.promises` (AC9). */
  fsOps?: Pick<typeof fs.promises, 'appendFile' | 'rename'>;
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

  return {
    uriFor,

    refusalFor: outsideRootRejection,

    async append(document, line): Promise<string | null> {
      const rejection = await outsideRootRejection(document);
      if (rejection !== null) {
        if (rejection === 'The comment sidecar would be written outside the allowed workspace.') {
          log(`Refused to write comment sidecar outside the allowed workspace: ${uriFor(document).toString()}`);
        }
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
      return { ...folded, warnings };
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
