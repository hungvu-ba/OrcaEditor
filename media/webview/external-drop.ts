/**
 * External drop (HLR section 17, US-17.6, M4): dragging a file in from
 * outside the editor (Explorer/Finder — OS-level drag, `dataTransfer.files`)
 * onto #content. Images reuse the existing paste-image.ts save+insert flow
 * verbatim (same host round-trip, same <img> insertion) — only the trigger
 * source and insertion position differ (drop point instead of the current
 * caret/selection). Non-image files go through a new `dropFile` message
 * (see src/shared/messages.ts) and get inserted as a `[name](path)` link.
 *
 * Scope cut, stated plainly: only real OS file drags are handled here
 * (`dataTransfer.files`, the common case — dragging from Finder/Explorer).
 * VS Code's OWN internal drag source (e.g. dragging a file from its Explorer
 * sidebar into a webview, which typically carries `text/uri-list` instead of
 * a readable Blob) is NOT handled — that would need the host to resolve the
 * URI itself rather than reading a Blob client-side, and its exact drag
 * payload shape isn't something this pass could verify without a live
 * webview to test against. Deferred rather than guessed at.
 *
 * Multiple files dropped in the same gesture are each requested
 * independently (their own async host round-trip) against the SAME captured
 * drop-point Range — with more than one file, insertion order/position
 * isn't guaranteed to match drop order. Single-file drop (the common case)
 * is unaffected.
 */
import { dataUrlToBase64, encodeLinkPath, readAsDataUrl, showToast } from './dom-utils';
import { ESCAPE_PRIORITY, registerEscapeHandler } from './escape-stack';
import type { PasteImageController } from './paste-image';
import type { VsCodeApi } from './vscode-api';

export interface ExternalDropDeps {
  vscode: VsCodeApi;
  pasteImage: PasteImageController;
  /** Renders markdown → HTML and inserts it at the caret (main.ts's insertMarkdownAtCaret) — reused so a dropped-file link renders immediately as a clickable <a>, not literal `[text](url)` characters. */
  insertMarkdown: (text: string) => void;
  /** dom-utils' canonical restoreSelection (from createDomHelpers) — reused instead of re-implementing the removeAllRanges/addRange/focus tail locally. */
  restoreSelection: (range: Range | undefined) => void;
}

export interface ExternalDropController {
  /** Call from main.ts's message handler on 'dropFileResult'. */
  notifyResult(requestId: number, relativePath?: string, error?: string): void;
}

export function initExternalDrop(content: HTMLElement, deps: ExternalDropDeps): ExternalDropController {
  let seq = 0;
  const pending = new Map<number, { range: Range | undefined; name: string }>();
  let dropTargetCell: Element | null = null;
  let dropCaret: HTMLElement | null = null;
  // dragover fires continuously; coalesce the layout-forcing highlight recompute
  // (caretRangeFromPoint + getBoundingClientRect) into one per frame — same
  // throttle discipline as match-utils/toc onScroll (Known Traps: performance).
  let rafId = 0;
  let pendingXY: { x: number; y: number } | null = null;
  // A file drag is currently hovering #content (drives the Escape-to-cancel
  // handler; false while no drag is over us so Escape falls through).
  let dragActive = false;
  // Escape was pressed mid-drag: swallow the rest of THIS gesture (no highlight,
  // no drop) until it leaves/ends, so releasing the mouse inserts nothing.
  let cancelled = false;

  function caretRangeAt(clientX: number, clientY: number): Range | undefined {
    return document.caretRangeFromPoint?.(clientX, clientY) ?? undefined;
  }

  /**
   * The range the drop WILL use — same value drives the highlight, so what the
   * user sees is exactly where the file lands (WYSIWYG). Falls back to the end
   * of the file when the point yields no caret (dropping into the empty margin
   * below the last block, or over an atomic element), instead of the stale
   * pre-drag caret the old code silently reused.
   */
  function dropRangeAt(clientX: number, clientY: number): Range {
    const at = caretRangeAt(clientX, clientY);
    if (at) {
      return at;
    }
    const range = document.createRange();
    if (content.lastChild) {
      range.setStartAfter(content.lastChild);
    } else {
      range.selectNodeContents(content);
    }
    range.collapse(false);
    return range;
  }

  function cellAt(range: Range | undefined): Element | null {
    if (!range) {
      return null;
    }
    const node = range.startContainer;
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    return el?.closest('td, th') ?? null;
  }

  function clearCellHighlight(): void {
    dropTargetCell?.classList.remove('dd-drop-target-cell');
    dropTargetCell = null;
  }

  function hideDropCaret(): void {
    if (dropCaret) {
      dropCaret.style.display = 'none';
    }
  }

  function clearHighlight(): void {
    clearCellHighlight();
    hideDropCaret();
  }

  /** Drop the current drag's transient state (highlight, queued frame, hover point). */
  function resetDragState(): void {
    dragActive = false;
    pendingXY = null;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    clearHighlight();
  }

  /** Escape while a file drag is over #content: kill the highlight and arm `cancelled` so the eventual drop inserts nothing. */
  function cancelDrag(): void {
    resetDragState();
    cancelled = true;
  }

  /** Collapsed-range caret rect; empty blocks / end-of-file give a zero rect, so fall back to the containing element's box collapsed to its trailing edge. */
  function caretRect(range: Range): { left: number; top: number; height: number } | null {
    const r = range.getBoundingClientRect();
    if (r.height > 0) {
      return { left: r.left, top: r.top, height: r.height };
    }
    const node = range.startContainer;
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const er = el?.getBoundingClientRect();
    if (er && er.height > 0) {
      return { left: er.left, top: er.top, height: er.height };
    }
    return null;
  }

  /** Thin vertical caret marking the exact insertion point for a non-cell drop. */
  function showDropCaretAt(range: Range): void {
    const rect = caretRect(range);
    if (!rect) {
      hideDropCaret();
      return;
    }
    if (!dropCaret) {
      dropCaret = document.createElement('div');
      dropCaret.className = 'dd-drop-caret';
      document.body.appendChild(dropCaret);
    }
    dropCaret.style.display = 'block';
    dropCaret.style.left = `${rect.left}px`;
    dropCaret.style.top = `${rect.top}px`;
    dropCaret.style.height = `${rect.height}px`;
  }

  /**
   * F8 (US-17.4 AC): highlight the destination cell while dragging over a table
   * cell; otherwise show the drop caret at the insertion point. Both track the
   * SAME dropRangeAt the drop handler uses.
   */
  function updateHighlight(): void {
    rafId = 0;
    if (!pendingXY) {
      return;
    }
    const range = dropRangeAt(pendingXY.x, pendingXY.y);
    const cell = cellAt(range);
    if (cell) {
      hideDropCaret();
      if (cell !== dropTargetCell) {
        clearCellHighlight();
        cell.classList.add('dd-drop-target-cell');
        dropTargetCell = cell;
      }
    } else {
      clearCellHighlight();
      showDropCaretAt(range);
    }
  }

  content.addEventListener('dragover', (e) => {
    // Only claim FILE drags — leave text/internal drags (e.g. contentEditable's
    // own "drag selected text to move it") to the browser's default handling.
    if (!e.dataTransfer?.types.includes('Files')) {
      return;
    }
    // Escape already cancelled this gesture: refuse to be a drop target (no
    // preventDefault) and show nothing, until the drag leaves/ends.
    if (cancelled) {
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dragActive = true;
    pendingXY = { x: e.clientX, y: e.clientY };
    if (!rafId) {
      rafId = requestAnimationFrame(updateHighlight);
    }
  });

  content.addEventListener('dragleave', (e) => {
    if (!(e.relatedTarget instanceof Node) || !content.contains(e.relatedTarget)) {
      // Gesture left #content — reset both flags so a fresh drag re-arms cleanly.
      resetDragState();
      cancelled = false;
    }
  });

  content.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files;
    const wasCancelled = cancelled;
    resetDragState();
    cancelled = false;
    if (!files || files.length === 0) {
      return;
    }
    e.preventDefault();
    // Escape-cancelled: preventDefault above suppresses the browser's default
    // file-open, but insert nothing.
    if (wasCancelled) {
      return;
    }
    const range = dropRangeAt(e.clientX, e.clientY);
    const fillCell = cellAt(range) !== null;
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        deps.pasteImage.saveDroppedImage(file, file.type, range, fillCell);
      } else {
        void requestDropFile(file, range);
      }
    }
  });

  // Escape cancels an in-flight file drag (shared capture-phase arbiter, DRAG
  // priority — same tier as internal block/li drag). Returns false when no file
  // drag is over us so the key falls through to popups/Zen/etc.
  registerEscapeHandler(ESCAPE_PRIORITY.DRAG, () => {
    if (!dragActive) {
      return false;
    }
    cancelDrag();
    return true;
  });

  async function requestDropFile(file: File, range: Range | undefined): Promise<void> {
    const requestId = ++seq;
    pending.set(requestId, { range, name: file.name });
    const base64 = dataUrlToBase64(await readAsDataUrl(file));
    if (!base64) {
      // Empty on read error too (readAsDataUrl resolves '') — same bail as the
      // previous FileReader.onerror path.
      pending.delete(requestId);
      return;
    }
    deps.vscode.postMessage({ type: 'dropFile', requestId, name: file.name, dataBase64: base64 });
  }

  function insertLinkAt(range: Range | undefined, name: string, relPath: string): void {
    deps.restoreSelection(range);
    deps.insertMarkdown(`[${name}](${encodeLinkPath(relPath)})`);
  }

  function notifyResult(requestId: number, relativePath?: string, error?: string): void {
    const entry = pending.get(requestId);
    pending.delete(requestId);
    if (!entry) {
      return;
    }
    if (relativePath) {
      insertLinkAt(entry.range, entry.name, relativePath);
    } else if (error) {
      showToast(error);
    }
  }

  return { notifyResult };
}
