/**
 * Req 24 US-23.18 AC6 — how many undo/redo steps a document actually owns.
 *
 * The webview's Ctrl+Z reaches `provider.ts` as an `undo` message, and the handler
 * answers it with `vscode.commands.executeCommand('undo')`. That command is **global**:
 * it acts on the workspace undo stack, not on a named document. When the document has
 * nothing of its own to undo, the command therefore consumes the next thing that IS on
 * that stack — and a probe on 2026-07-28 measured what that is in practice: **a file
 * rename**. Rename an `.md`, open it, press Ctrl+Z having typed nothing, and the rename
 * is reverted. The same probe renamed a `.txt`, which no extension participant touches
 * at all, and VS Code reverted that too — so this is stock behaviour of an unscoped
 * `undo`, not a defect in US-23.5's sidecar-rename `WorkspaceEdit`.
 *
 * VS Code exposes no way to ask "does this document have undo history?" (the PO decision
 * behind AC6's probe-first rule says exactly this), so track it. `onDidChangeTextDocument`
 * carries a `reason` distinguishing a fresh edit from an undo and a redo, which is enough
 * to mirror the document's own two stack depths — from ANY source, not just this
 * extension's edits, which is what keeps a document edited in a side-by-side text editor
 * from being wrongly refused.
 *
 * Kept `vscode`-free so `test/unit.ts` can drive the state machine directly: the handler
 * that consults it cannot be reached from the host track, since the public API offers no
 * way to open a custom editor's webview and post a message to it.
 */

/** The two directions a webview request can travel. */
export type UndoAction = 'undo' | 'redo';

/**
 * `vscode.TextDocumentChangeReason`'s numeric values, restated so this module stays
 * `vscode`-free. They are part of the stable API surface (`Undo = 1`, `Redo = 2`), and
 * `undefined` — every other edit — is the third case.
 */
const CHANGE_REASON_UNDO = 1;
const CHANGE_REASON_REDO = 2;

/** Maps a change event's `reason` onto the ledger's vocabulary. */
export function undoLedgerReasonOf(reason: number | undefined): UndoLedgerReason {
  if (reason === CHANGE_REASON_UNDO) {
    return 'undo';
  }
  if (reason === CHANGE_REASON_REDO) {
    return 'redo';
  }
  return 'edit';
}

/**
 * What a change event says about the document's history. Mirrors
 * `vscode.TextDocumentChangeReason` plus the `undefined` case (a fresh edit).
 */
export type UndoLedgerReason = 'edit' | 'undo' | 'redo';

/** One document's undo and redo depth, as far as its change events reveal. */
export interface UndoLedger {
  readonly undoable: number;
  readonly redoable: number;
}

export function emptyUndoLedger(): UndoLedger {
  return { undoable: 0, redoable: 0 };
}

/**
 * The document's history after one change event — ordinary undo-stack arithmetic.
 *
 * A fresh edit clears the redo side, because VS Code does: once you type after undoing,
 * the redone-away future is gone. Both counters floor at 0 rather than going negative, so
 * an unpaired event (a reason we never saw the matching edit for — the document was
 * already open before this ledger existed) degrades to "nothing known" instead of
 * poisoning every later decision with a negative count.
 */
export function recordUndoLedgerChange(ledger: UndoLedger, reason: UndoLedgerReason): UndoLedger {
  switch (reason) {
    case 'edit':
      return { undoable: ledger.undoable + 1, redoable: 0 };
    case 'undo':
      return { undoable: Math.max(0, ledger.undoable - 1), redoable: ledger.redoable + 1 };
    case 'redo':
      return { undoable: ledger.undoable + 1, redoable: Math.max(0, ledger.redoable - 1) };
  }
}

/**
 * May the provider forward `action` to the global `undo`/`redo` command?
 *
 * False means "this document owns no such step", and the caller must NOT issue the
 * command — issuing it is what reaches past this document and eats a file rename. False
 * is also the answer for a document this ledger has never seen a change for, which is
 * the common case for a file opened and not edited: exactly AC6's precondition.
 */
export function canForwardUndo(ledger: UndoLedger | undefined, action: UndoAction): boolean {
  if (ledger === undefined) {
    return false;
  }
  return action === 'undo' ? ledger.undoable > 0 : ledger.redoable > 0;
}
