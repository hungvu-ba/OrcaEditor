/**
 * "Search again →" popover (Req 20 US-20.9 / Req 21 US-21.3's broken-reference
 * tooltip action) — a small anchored file picker, pre-seeded with the broken
 * reference's current display text, following the cross-file-search popover's
 * anchor-and-clamp pattern (not a full-screen `prompt.ts` modal).
 *
 * Two scopes, chosen from the broken anchor's kind: Files (host `searchFiles`/
 * `fileSearchResult`) for a broken file link, and Entities (Req 21 US-21.3, host
 * `entitySearch`/`entityResult`) for a broken entity reference. Both reuse the
 * same shell (input + results + escape + outside-click); an Entities pick does
 * replace-in-place (rewrites the href id, keeps display text) and optionally
 * Fix-all across every same-id occurrence in the current file.
 */
import { el, encodeLinkPath, positionNear, relativeLinkPath } from './dom-utils';
import { initPopoverDismiss } from './escape-stack';
import { QUICK_CORRECT_SEARCH_DEBOUNCE_MS } from './constants';
import { AUTOLINK_PATH_ATTR, ENTITY_REF_CLASS } from './render';
import type { VsCodeApi } from './vscode-api';
import type { EntitySuggestion, FileSuggestion } from '../../src/shared/messages';

export interface QuickCorrectController {
  /**
   * Open the popover for one broken-reference anchor, seeded with its current
   * display text. `opts.fixAll` (Req 21 US-21.3, entity refs only) applies the
   * single pick to every same-id occurrence in the current file.
   */
  open(anchor: HTMLAnchorElement, opts?: { fixAll?: boolean }): void;
  /** Req 21 — set from `InitConfig.docUri`; used to relativize a corrected entity's declaring-file href (mirrors trigger-at.ts's insert path). */
  setDocUri(uri: string): void;
  /** Message-handler hook: forward a `fileSearchResult` reply here (own requestId sequence — ignored if stale). */
  notifyFileSearchResult(requestId: number, files: FileSuggestion[]): void;
  /** Message-handler hook: forward an `entityResult` reply here (Req 21 US-21.3, own requestId sequence — ignored if stale). */
  notifyEntityResult(requestId: number, ready: boolean, entities: EntitySuggestion[]): void;
}

/**
 * Rewrite `anchor`'s target to `file` in place, keeping its visible display
 * text (the whole point of "quick-correct": fix the target, not the prose).
 * An auto-linked bare-path anchor (`AUTOLINK_PATH_ATTR` present — see
 * `postProcessRelativePathLinks`) serializes from that attribute, not `href`
 * (see turndown.ts's `autolinkPath` rule) and shows only the basename as its
 * text — both must be updated together or the fix wouldn't round-trip/display
 * correctly. A real Markdown link (`[display text](path)`, no attribute) only
 * needs `href` changed — its display text is untouched, matching the plan.
 */
function applyFix(anchor: HTMLAnchorElement, file: FileSuggestion): void {
  if (anchor.hasAttribute(AUTOLINK_PATH_ATTR)) {
    anchor.setAttribute(AUTOLINK_PATH_ATTR, file.path);
    anchor.textContent = file.name;
  }
  anchor.setAttribute('href', encodeLinkPath(file.path));
}

/**
 * Req 21 US-21.3 (replace-in-place): rewrite a broken entity ref's target to the
 * picked entity's full id, LEAVING its display text untouched (US-21.3: "only the
 * target is replaced at each site" / "keeps its own original display text").
 * An entity reference is always a real `[text](#id)`/`[text](path#id)` link, so
 * only the `href` changes — never AUTOLINK_PATH_ATTR (entity refs are never
 * bare-path autolinks). The file part is recomputed from the PICKED entity's
 * declaring file relativized against `docUri` (identical to trigger-at.ts's
 * insert path) — reusing the old href's file part would keep pointing at the old
 * file when the correct declaration lives elsewhere (bug: correction opened the
 * old file). Empty relative path → same-file bare `#id`.
 */
function applyEntityFix(anchor: HTMLAnchorElement, entity: EntitySuggestion, docUri: string): void {
  const filePart = entity.file === docUri ? '' : encodeLinkPath(relativeLinkPath(docUri, entity.file));
  anchor.setAttribute('href', `${filePart}#${entity.namespace}${entity.id}`);
}

export function initQuickCorrect(vscode: VsCodeApi, content: HTMLElement, onFixed: () => void): QuickCorrectController {
  const popover = el('div', 'quick-correct-popover');
  popover.hidden = true;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'quick-correct-input';
  input.placeholder = 'Search for the correct file…';
  popover.appendChild(input);

  const resultsEl = el('div', 'quick-correct-results');
  popover.appendChild(resultsEl);

  document.body.appendChild(popover);

  let currentAnchor: HTMLAnchorElement | undefined;
  /** Req 21 — `InitConfig.docUri`; used to relativize a corrected entity's declaring-file href. */
  let docUri = '';
  /** Req 21 US-21.3: current anchor is an entity ref → search Entities, not Files. */
  let currentIsEntity = false;
  /** Req 21 US-21.3: the pick applies to every same-id occurrence in the current file. */
  let currentFixAll = false;
  let searchSeq = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const dismiss = initPopoverDismiss(popover, () => {
    currentAnchor = undefined;
    if (searchTimer !== undefined) {
      clearTimeout(searchTimer);
      searchTimer = undefined;
    }
  });

  function renderResults(files: FileSuggestion[]): void {
    resultsEl.textContent = '';
    if (files.length === 0) {
      resultsEl.appendChild(el('div', 'quick-correct-empty', 'No matching files'));
      return;
    }
    for (const file of files) {
      const row = el('button', 'quick-correct-item');
      row.type = 'button';
      row.append(el('span', 'quick-correct-item-name', file.name), el('span', 'quick-correct-item-dir', file.dir));
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => pick(file));
      resultsEl.appendChild(row);
    }
  }

  /** Req 21 US-21.3: render one Entities-scope result row per suggestion (name = full id, detail = nearest heading). */
  function renderEntityResults(ready: boolean, entities: EntitySuggestion[]): void {
    resultsEl.textContent = '';
    if (!ready) {
      // Indexing state — never let an empty list read as "nothing exists" (US-21.2/21.3).
      resultsEl.appendChild(el('div', 'quick-correct-empty', 'Indexing workspace…'));
      return;
    }
    if (entities.length === 0) {
      resultsEl.appendChild(el('div', 'quick-correct-empty', 'No matching entities'));
      return;
    }
    for (const entity of entities) {
      const row = el('button', 'quick-correct-item');
      row.type = 'button';
      row.append(
        el('span', 'quick-correct-item-name', `${entity.namespace}${entity.id}`),
        el('span', 'quick-correct-item-dir', entity.title)
      );
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => pickEntity(entity));
      resultsEl.appendChild(row);
    }
  }

  function pick(file: FileSuggestion): void {
    const anchor = currentAnchor;
    if (!anchor) {
      return;
    }
    applyFix(anchor, file);
    dismiss.close();
    onFixed();
  }

  /**
   * Req 21 US-21.3: apply the picked entity. For a normal pick, only the hovered
   * anchor; for Fix-all, every entity ref in the CURRENT file whose display text
   * matches the broken id (single-file only in v1 — other-file occurrences are
   * counted, not rewritten). Each anchor keeps its own display text.
   */
  function pickEntity(entity: EntitySuggestion): void {
    const anchor = currentAnchor;
    if (!anchor) {
      return;
    }
    if (currentFixAll) {
      const brokenId = (anchor.textContent ?? '').trim();
      for (const a of Array.from(content.querySelectorAll(`a.${ENTITY_REF_CLASS}`)) as HTMLAnchorElement[]) {
        if ((a.textContent ?? '').trim() === brokenId) {
          applyEntityFix(a, entity, docUri);
        }
      }
    } else {
      applyEntityFix(anchor, entity, docUri);
    }
    dismiss.close();
    onFixed();
  }

  function runSearch(query: string): void {
    const q = query.trim();
    if (!q) {
      if (currentIsEntity) {
        renderEntityResults(true, []);
      } else {
        renderResults([]);
      }
      return;
    }
    if (currentIsEntity) {
      vscode.postMessage({ type: 'entitySearch', query: q, requestId: ++searchSeq });
    } else {
      vscode.postMessage({ type: 'searchFiles', query: q, requestId: ++searchSeq });
    }
  }

  input.addEventListener('input', () => {
    if (searchTimer !== undefined) {
      clearTimeout(searchTimer);
    }
    searchTimer = setTimeout(() => runSearch(input.value), QUICK_CORRECT_SEARCH_DEBOUNCE_MS);
  });

  function open(anchor: HTMLAnchorElement, opts?: { fixAll?: boolean }): void {
    if (dismiss.isOpen) {
      dismiss.close();
    }
    currentAnchor = anchor;
    currentIsEntity = anchor.classList.contains(ENTITY_REF_CLASS);
    currentFixAll = currentIsEntity && !!opts?.fixAll;
    popover.hidden = false;
    positionNear(popover, anchor.getBoundingClientRect());
    input.placeholder = currentIsEntity ? 'Search for the correct entity…' : 'Search for the correct file…';
    input.value = anchor.textContent ?? '';
    if (currentIsEntity) {
      renderEntityResults(true, []);
    } else {
      renderResults([]);
    }
    dismiss.arm();
    // preventScroll: focusing the seeded input must not jump the page to the top —
    // the broken anchor stays put so the fixed popover keeps its anchored position.
    input.focus({ preventScroll: true });
    input.select();
    runSearch(input.value);
  }

  return {
    open,
    setDocUri(uri) {
      docUri = uri;
    },
    notifyFileSearchResult(requestId, files) {
      if (requestId !== searchSeq || currentIsEntity) {
        return; // stale/superseded, or the popover is in Entities mode — discard.
      }
      renderResults(files);
    },
    notifyEntityResult(requestId, ready, entities) {
      if (requestId !== searchSeq || !currentIsEntity) {
        return; // stale/superseded, or the popover is in Files mode — discard.
      }
      renderEntityResults(ready, entities);
    },
  };
}
