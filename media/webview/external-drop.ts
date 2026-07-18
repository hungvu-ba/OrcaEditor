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

  function caretRangeAt(clientX: number, clientY: number): Range | undefined {
    return document.caretRangeFromPoint?.(clientX, clientY) ?? undefined;
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

  /** F8 (US-17.4 AC): highlight the destination cell while dragging an external image over it. */
  function highlightCellAt(clientX: number, clientY: number): void {
    const cell = cellAt(caretRangeAt(clientX, clientY));
    if (cell === dropTargetCell) {
      return;
    }
    clearCellHighlight();
    if (cell) {
      cell.classList.add('dd-drop-target-cell');
      dropTargetCell = cell;
    }
  }

  content.addEventListener('dragover', (e) => {
    // Only claim FILE drags — leave text/internal drags (e.g. contentEditable's
    // own "drag selected text to move it") to the browser's default handling.
    if (!e.dataTransfer?.types.includes('Files')) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    highlightCellAt(e.clientX, e.clientY);
  });

  content.addEventListener('dragleave', (e) => {
    if (!(e.relatedTarget instanceof Node) || !content.contains(e.relatedTarget)) {
      clearCellHighlight();
    }
  });

  content.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files;
    clearCellHighlight();
    if (!files || files.length === 0) {
      return;
    }
    e.preventDefault();
    const range = caretRangeAt(e.clientX, e.clientY);
    const fillCell = cellAt(range) !== null;
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        deps.pasteImage.saveDroppedImage(file, file.type, range, fillCell);
      } else {
        void requestDropFile(file, range);
      }
    }
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
