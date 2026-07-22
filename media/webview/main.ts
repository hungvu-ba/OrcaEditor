/**
 * Webview WYSIWYG cho Markdown:
 *  - Render bằng markdown-it (giống VS Code Markdown Preview).
 *  - #content là contentEditable; mọi thay đổi được serialize về markdown
 *    (turndown) và gửi cho extension (debounce).
 *  - Update từ ngoài (text editor, git...) → render lại, giữ vị trí scroll.
 *
 * File này chỉ còn vai trò "composition root": khởi tạo renderer/turndown,
 * nối các module tính năng (toolbar, table, input-rules, prompt, search, toc)
 * lại với nhau, và xử lý các sự kiện xuyên suốt cả trang (sync, paste, mở
 * link, phím tắt định dạng).
 */
import {
  MarkdownRenderer,
  createTurndown,
  findOrphanNestedListPair,
  normalizeMarkdown,
  postProcessMathDom,
  postProcessMermaidDom,
  postProcessCodeHeaders,
  postProcessRelativePathLinks,
  postProcessCaptions,
  postProcessEntityRefs,
  postProcessEmptyLinks,
  prepareDomForSerialize,
  CAPTION_CLASS,
  AUTOLINK_PATH_ATTR,
  MD_CODE_COPY_CLASS,
  MD_CODE_LANG_CLASS,
  MD_CODE_WRAP_CLASS,
  MD_CODE_WRAPPED_CLASS,
} from './pipeline';
import { initSearch } from './search';
import { initSelectHighlight } from './select-highlight';
import { initCrossFileSearch } from './cross-file-search';
import { initToc } from './toc';
import { initBrokenRef, slugifyHeadingText } from './broken-ref';
import { initQuickCorrect } from './quick-correct';
import { initCaptionEdit } from './caption-edit';
import { initMermaid } from './mermaid';
import { initMathEdit } from './math-edit';
import { initLineGutter } from './gutter';
import { buildBlockMap, BLOCK_ID_ATTR, type BlockEntry } from './block-map';
import { readSrcRange } from './block-info';
import { detectBlockStyle, stampStyleOverride, LANG_SWITCHED_ATTR } from './block-style';
import { initDragDrop, computeHeadingSectionSpan, headingLevel } from './drag-drop';
import { closestElement, createDomHelpers, emptyParagraph, encodeLinkPath, getOffsetWithin, scrollBehavior, textAfterCaret, textBeforeCaret } from './dom-utils';
import { computeIndent, computeOutdent, commitListOpDirect } from './list-ops';
import { initPasteImage } from './paste-image';
import { initExternalDrop } from './external-drop';
import { initReadability } from './readability';
import { initImageZoom } from './image-zoom';
import {
  initToolbar,
  syncTocButton,
  syncReadingButtons,
  toggleInlineCode,
  isPopoverOpen,
  openCodeLangSwitcher,
  initBrokenRefBadge,
  syncBrokenRefBadge,
  initToolbarTriggerAt,
} from './toolbar';
import { initTable, navigateCells, warnIfComplexTableList, fitTableColumns } from './table';
import { initStickyTableHeader } from './table-sticky-header';
import { initInputRules, caretAtStartOfListItem } from './input-rules';
import { hasInputOwner, onInputOwnerRelease } from './input-ownership';
import { initTriggerPopup, type TriggerPopupController } from './trigger-popup';
import { initTriggerSlash } from './trigger-slash';
import { initTriggerAt } from './trigger-at';
import { initEntityScope } from './entity-scope';
import type { VsCodeApi } from './vscode-api';
import type { HostToWebview, InitConfig, TriggerMode, WebviewToHost } from '../../src/shared/messages';
import { normalizeHrefKey } from '../../src/references-section';
import { SYNC_DEBOUNCE_MS, SCROLL_SAVE_DEBOUNCE_MS } from './constants';

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

/** Gửi message tới host theo đúng hợp đồng WebviewToHost (C3). */
function postToHost(msg: WebviewToHost): void {
  vscode.postMessage(msg);
}
const content = document.getElementById('content') as HTMLDivElement;
const toolbarEl = document.getElementById('toolbar') as HTMLDivElement;
const gutterEl = document.getElementById('line-gutter') as HTMLDivElement | null;

let renderer: MarkdownRenderer | undefined;
const turndown = createTurndown();
const search = initSearch(content);
// C1: Feature A tự tắt hẳn (không paint, không build overview strip) khi Ctrl+F đang mở —
// truyền accessor isOpen() của search thay vì cả controller để giữ phụ thuộc tối thiểu.
const selectHighlight = initSelectHighlight(content, () => search.isOpen());
const crossFileSearch = initCrossFileSearch(content, vscode);
const toc = initToc(content, vscode);
const mermaidView = initMermaid(content);
initMathEdit(content);
const lineGutter = initLineGutter(content, gutterEl, () => renderer);
let lineNumbersEnabled = false;
const dom = createDomHelpers(content);
// US-17.3: block reorder engine — needs lineGutter (refresh after a move) and
// scheduleSync (declared below; safe to reference here, function declarations hoist).
const dragDrop = initDragDrop(content, {
  scheduleSync,
  dom,
  lineGutter,
  // Same caret-host invariants renderDocument enforces — reused after a handle-delete (bug
  // General #1) whose suppressed host echo means renderDocument won't re-run.
  ensureCaretHost: () => {
    ensureCaretSpotAfterAtomBlocks();
    ensureCaretSpotBeforeHr();
    ensureTrailingParagraph();
  },
});
const pasteImage = initPasteImage(vscode, { scheduleSync, dom });
// US-17.6: external file drop (Explorer/Finder) — needs pasteImage (images reuse
// its save+insert flow) and insertMarkdownAtCaret (hoisted function, declared below).
const externalDrop = initExternalDrop(content, {
  vscode,
  pasteImage,
  insertMarkdown: insertMarkdownAtCaret,
  restoreSelection: dom.restoreSelection,
});
const table = initTable(content, toolbarEl, { scheduleSync, dom });
// US-19.14: header cột "dính" dưới toolbar khi cuộn bảng dài (đọc tên cột liên tục).
const stickyTableHeader = initStickyTableHeader(content, toolbarEl);
// Reading Mode (US-19.24) — controller lái CSS class/var. enabled/mode
// global-in-memory ở host (bug 0716 #2, đảo ngược bug 0715 mục 4), cùng mô
// hình zen (US-19.19, xem onZenChange) nhưng kênh riêng.
const readability = initReadability({
  content,
  toolbar: toolbarEl,
  syncButtons: syncReadingButtons,
  // Zen reveal không được ẩn toolbar khi đang mở dropdown (xem ReadabilityDeps).
  isPopoverOpen,
  onZenChange: (zen) => postToHost({ type: 'zenChanged', zen }),
  onReadingModeChange: (state) => postToHost({ type: 'readingModeChanged', ...state }),
  // bug_General #7: khi commit 1 bộ style, Mermaid dựng lại nếu nền sáng/tối lật.
  onStyleApplied: () => mermaidView.refreshTheme(),
});
initImageZoom(content, toolbarEl);
initToolbar(content, toolbarEl, {
  vscode,
  scheduleSync,
  flushPendingSync,
  syncNow,
  // Same host-delegation contract as the Ctrl+Z/Y keydown path below: one
  // single TextDocument undo stack, never the browser's native one.
  requestUndo: () => postToHost({ type: 'undo', pendingText: takePendingSync() }),
  requestRedo: () => postToHost({ type: 'redo', pendingText: takePendingSync() }),
  dom,
  toc,
  readability,
  insertMarkdown: insertMarkdownAtCaret,
});
initInputRules(content, { scheduleSync, dom });

// Req 20 US-20.1/20.2/20.3: ONE shared trigger-popup shell — created LAZILY on
// first open(). Both the `@` (trigger-at) and `/` (trigger-slash) triggers plug
// their own dataSource into this SAME single instance, which is what gives "only
// one overlay active at a time" for free (open() tears down any previous session
// before opening, see trigger-popup.ts). It must NOT be built eagerly at init:
// initTriggerPopup() appends a `.trigger-popup` card to the body, and a standing
// hidden card at startup shadows the debug-driven card the shell spec drives —
// the exact foundation bug. `isOpen()` therefore never forces construction (it
// answers false until something has actually opened the popup).
let sharedTriggerPopup: TriggerPopupController | undefined;
const triggerPopup: TriggerPopupController = {
  open: (args) => {
    if (!sharedTriggerPopup) {
      sharedTriggerPopup = initTriggerPopup({ content });
    }
    sharedTriggerPopup.open(args);
  },
  updateQuery: (q) => sharedTriggerPopup?.updateQuery(q),
  isOpen: () => sharedTriggerPopup?.isOpen() ?? false,
  close: () => sharedTriggerPopup?.close(),
  showGhost: (text, afterRange) => sharedTriggerPopup?.showGhost(text, afterRange),
  hideGhost: () => sharedTriggerPopup?.hideGhost(),
};
const triggerSlash = initTriggerSlash(content, triggerPopup, postToHost);
const triggerAt = initTriggerAt(content, triggerPopup, postToHost);
// Req 20 US-20.8: toolbar Link/Image buttons invoke trigger-at.ts's popup —
// wired here (not a field on initToolbar's args) because initToolbar runs
// BEFORE triggerAt exists in this init order (same reason as initBrokenRefBadge).
initToolbarTriggerAt(triggerAt.openFromToolbar);

// Req 21 US-21.3: `UC01.` dot-drill (current-document scope) + entity-ref
// hover parent-context — own `input`/hover wiring, independent of trigger-at's
// `@` detection (fires on '.' typed right after an already-inserted entity
// reference, not on '@').
// Req 21 hover tooltip: id → following-text preview for CROSS-FILE mentions,
// populated from every `entitiesExistResult` reply (the broken-ref scan already
// round-trips every mention id through the host). Same-file previews are read
// straight from the DOM in entity-scope.ts and don't need this cache.
const entityPreviewById = new Map<string, string>();
const entityScope = initEntityScope(content, triggerPopup, (id) => entityPreviewById.get(id));
content.addEventListener('input', (e) => entityScope.onInput(e as InputEvent));
content.addEventListener('mousemove', (e) => entityScope.onMouseMove(e), true);
content.addEventListener('mouseout', (e) => entityScope.onMouseOut(e), true);

// Req 20 US-20.9 / Req 21 US-21.3: broken-reference marker (file/heading links
// only for now) + its "Search again" quick-correct popover. quickCorrect is
// created first; its onFixed callback references brokenRef (assigned right
// after) — safe because both callbacks only ever run later, from a user
// interaction, well after this synchronous init block has finished.
const quickCorrect = initQuickCorrect(vscode, content, () => {
  scheduleSync();
  brokenRef.refresh();
});
const brokenRef = initBrokenRef({
  content,
  vscode,
  onSearchAgain: (anchor) => quickCorrect.open(anchor),
  // Req 21 US-21.3: "Fix all" — one pick applied to every same-id occurrence in this file.
  onFixAll: (anchor) => quickCorrect.open(anchor, { fixAll: true }),
  // Req 21 US-21.3: right-pinned toolbar count badge, recomputed live from
  // every recompute pass (current document only).
  onChange: () => syncBrokenRefBadge(),
});
initBrokenRefBadge(() => brokenRef.list());

// bug_General Mention Declare #6: click a declaration pill (.md-caption, a
// non-editable atom) to edit its value via an anchored popover with duplicate
// validation. onEdited persists the rewritten token to the document.
const captionEdit = initCaptionEdit(vscode, () => {
  scheduleSync();
});
content.addEventListener('click', (e) => {
  const badge = (e.target as Element | null)?.closest?.(`.${CAPTION_CLASS}`);
  if (badge) {
    e.preventDefault();
    captionEdit.open(badge as HTMLElement);
  }
});

/**
 * Đồng bộ chiều cao toolbar (sticky, top:0) vào CSS var `--toolbar-height` để
 * `scroll-padding-top` (editor.css) chừa đúng khoảng đó: mọi scrollIntoView
 * (block:'start') khi nhảy heading/anchor/reveal-source-line dừng NGAY DƯỚI
 * toolbar thay vì để heading trốn sau toolbar (bug 0715: heading đầu file bị
 * toolbar che, không cuộn lên xem được vì đã chạm đỉnh trang). Dùng
 * ResizeObserver vì toolbar cao/thấp đổi theo font/độ rộng tab.
 */
function syncToolbarHeightVar(): void {
  const h = toolbarEl.offsetHeight;
  document.documentElement.style.setProperty('--toolbar-height', `${h}px`);
}
new ResizeObserver(syncToolbarHeightVar).observe(toolbarEl);
syncToolbarHeightVar();

/** Markdown hiện tại mà webview đã biết (đã render hoặc đã gửi lên). */
let currentText = '';
let syncTimer: ReturnType<typeof setTimeout> | undefined;
/** Block Map (HLR mục 18, US-18.1) — chỉ mục block cấp cao nhất, dựng lại ở cuối mỗi renderDocument(). */
let blockMap: BlockEntry[] = [];

// ---------------------------------------------------------------------------
// Khởi tạo
// ---------------------------------------------------------------------------

document.execCommand('defaultParagraphSeparator', false, 'p');

/**
 * Reference prose-column width = reading measure 70ch
 * @ 16px font (markdown.css body.reading-mode #content). ch→px via the
 * fixed estimate 1ch ≈ 0.5em → 70 × 0.5 × 16 = 560px. A reference constant,
 * independent of whether Reading Mode is currently on.
 */
const COMFORTABLE_MEASURE_PX = 70 * 0.5 * 16;

/** Right-side space body.toc-open reserves BEYOND --toc-width (editor.css). */
const TOC_GUTTER_PX = 26;

/**
 * The tab (webview) is no longer wide enough to show the prose column at
 * Comfortable Reading size WHILE the TOC panel is open → auto-hide so content
 * isn't squeezed too narrow. Threshold = reference column (COMFORTABLE_MEASURE_PX)
 * + panel width (--toc-width, read live since the user can resize it) + gutter.
 * Compared against window.innerWidth (tab width), not the physical screen.
 */
function isNarrowViewport(): boolean {
  const tocWidth =
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--toc-width')) || 300;
  return window.innerWidth < COMFORTABLE_MEASURE_PX + tocWidth + TOC_GUTTER_PX;
}

/**
 * Có nên tự mở panel mục lục lúc khởi tạo không? Ngoài cờ config + viewport đủ
 * rộng, còn yêu cầu tài liệu có ÍT NHẤT 2 heading — file rỗng/không heading thì
 * TOC luôn trống ("No headings yet"), còn tài liệu chỉ có đúng 1 heading thì
 * mục lục không giúp điều hướng gì (chỉ 1 mục trỏ về đầu file đang đọc); cả
 * hai trường hợp tự bật lên chỉ tổ chiếm chỗ (bug report 2026-07-15 mục 6).
 * Người dùng vẫn bật tay bằng nút toolbar được.
 */
function shouldAutoOpenToc(flag: boolean | undefined): boolean {
  return (
    flag !== false &&
    !toc.isOpen() &&
    !isNarrowViewport() &&
    content.querySelectorAll('h1, h2, h3, h4, h5, h6').length > 1
  );
}

/**
 * Cờ autoOpenToc lần gần nhất đã biết. `configUpdate` được host phát cho MỌI
 * thay đổi setting (kể cả bật Reading/Focus mode) — nếu cứ thế gọi lại
 * shouldAutoOpenToc thì mỗi lần bấm nút đó TOC lại nhảy ra. Chỉ auto-open khi cờ
 * này THỰC SỰ đổi (hoặc lần init đầu), không phải mỗi lần config đổi bất kỳ.
 */
let lastAutoOpenToc: boolean | undefined;

/**
 * Req 21 US-21.5 — propagate `orcaEditor.triggerActions.mode` to both trigger
 * modules (seed at 'init', live-updated on 'configUpdate') and mirror it onto
 * `body[data-trigger-mode]` — an observable hook for tests/future CSS, gating
 * visibility only, never restyling/hiding already-written content.
 */
function applyTriggerMode(mode: TriggerMode): void {
  document.body.dataset.triggerMode = mode;
  triggerSlash.setTriggerMode(mode);
  triggerAt.setTriggerMode(mode);
}

window.addEventListener('message', (event) => {
  const msg = event.data as HostToWebview;
  switch (msg.type) {
    case 'init': {
      const cfg: Partial<InitConfig> = msg.config ?? { breaks: false, linkify: true };
      renderer = new MarkdownRenderer({ breaks: !!cfg.breaks, linkify: !!cfg.linkify });
      applyPreviewFontSettings(cfg);
      lineNumbersEnabled = cfg.showLineNumbers !== false;
      document.body.classList.toggle('md-line-numbers', lineNumbersEnabled);
      crossFileSearch.setDefaultScope(cfg.crossFileSearchScope ?? 'markdown');
      if (cfg.readability) {
        readability.applyFromHost(cfg.readability);
      }
      // Req 20 US-20.2/20.3: seed the `/` trigger popup — docUri is echoed back
      // on 'executeCommand' so the host can verify this document is still the
      // target (see triggerSlash.setDocUri).
      triggerSlash.setDocUri(msg.docUri);
      triggerSlash.setConfig(cfg.trigger);
      // Req 21 US-21.2: the `@` popup's Entities scope also needs docUri, to
      // relativize a picked entity's declaring-file href client-side.
      triggerAt.setDocUri(msg.docUri);
      // Req 21 bug fix: the quick-correct popover needs docUri to relativize a
      // corrected entity's declaring-file href (else it keeps the old file).
      quickCorrect.setDocUri(msg.docUri);
      // Req 21 US-21.5: also seed the `@` popup's gate.
      applyTriggerMode(cfg.trigger?.mode ?? 'advanced');
      renderDocument(msg.text ?? '');
      // C6: nếu panel này vừa được mở từ 1 kết quả tìm xuyên file, ưu tiên
      // scroll tới đúng vị trí match đó thay vì khôi phục scrollTop cũ đã
      // lưu — chỉ fallback về restoreScroll() cho luồng mở file bình thường.
      if (msg.reveal?.searchText) {
        // Bug General #1: entity link → reveal by whole-doc text search (works
        // for out-of-workspace targets; immune to line↔DOM drift).
        lineGutter.scrollToText(msg.reveal.searchText);
      } else if (msg.reveal) {
        lineGutter.scrollToSourceLine(msg.reveal.line + 1, msg.reveal.character, msg.reveal.length, msg.reveal.matchText);
      } else {
        restoreScroll();
      }
      if (shouldAutoOpenToc(cfg.autoOpenToc)) {
        toc.toggle();
        syncTocButton();
      }
      lastAutoOpenToc = cfg.autoOpenToc;
      break;
    }
    case 'update': {
      if (msg.text === currentText) {
        break;
      }
      // Bug #3 (filter leak): while a trigger popup (`/`/`@`) owns the editor
      // keyboard it anchors a Range into #content and keeps its query input
      // focused. Rebuilding #content NOW would detach that Range and
      // restoreCaretAtSource would steal focus back to #content — the filter
      // text typed next then leaks into the editor (+ a stray newline on Enter).
      // Defer the render until the popup releases input ownership (commit/cancel).
      if (hasInputOwner()) {
        pendingUpdate = { text: msg.text ?? '', caretLine: msg.caretLine, caretCol: msg.caretCol, baseText: currentText };
        break;
      }
      applyDocumentUpdate(msg.text ?? '', msg.caretLine, msg.caretCol);
      break;
    }
    case 'fileSearchResult': {
      // quick-correct.ts and trigger-at.ts (Req 20 US-20.1 `@` Files scope)
      // share the SAME 'searchFiles'/'fileSearchResult' channel (each keeps
      // its own requestId sequence — ignores this if it isn't the one it's
      // waiting for), so no new host message shape.
      quickCorrect.notifyFileSearchResult(Number(msg.requestId ?? 0), msg.files ?? []);
      triggerAt.notifyFileSearchResult(Number(msg.requestId ?? 0), msg.files ?? []);
      break;
    }
    case 'namespaceListResult': {
      // Req 21 US-21.1's Declare-entity flow (triggerSlash) and Req 21 US-21.2's
      // `@` Entities scope (triggerAt) share the SAME 'namespaceList'/
      // 'namespaceListResult' channel (each keeps its own requestId sequence —
      // ignores this if it isn't the one it's waiting for), same pattern as
      // 'fileSearchResult' above.
      triggerSlash.notifyNamespaceListResult(msg.requestId, msg.ready, msg.namespaces);
      triggerAt.notifyNamespaceListResult(msg.requestId, msg.ready, msg.namespaces);
      break;
    }
    case 'entityResult': {
      // Same sharing as 'namespaceListResult' above, for 'entitySearch' — now
      // also the broken-entity quick-correct's Entities scope (Req 21 US-21.3).
      triggerSlash.notifyEntityResult(msg.requestId, msg.ready, msg.entities);
      triggerAt.notifyEntityResult(msg.requestId, msg.ready, msg.entities);
      quickCorrect.notifyEntityResult(msg.requestId, msg.ready, msg.entities);
      captionEdit.notifyEntityResult(msg.requestId, msg.ready, msg.entities);
      break;
    }
    case 'pasteImageResult': {
      pasteImage.notifyResult(msg.requestId, msg.relativePath, msg.error);
      break;
    }
    case 'dropFileResult': {
      externalDrop.notifyResult(msg.requestId, msg.relativePath, msg.error);
      break;
    }
    case 'crossFileSearch:result': {
      crossFileSearch.notifyResult(msg.requestId, msg.groups, msg.truncated, msg.usedFallback);
      break;
    }
    case 'targetsExistResult': {
      brokenRef.notifyResult(msg.requestId, msg.docVersion, msg.results);
      break;
    }
    case 'entitiesExistResult': {
      // Cache each id's preview for the cross-file hover tooltip (Req 21).
      // Set unconditionally (incl. '') so a declaration that lost its following
      // text — or became unresolved — clears any stale cached preview.
      for (const r of msg.results) {
        entityPreviewById.set(r.id, r.preview ?? '');
      }
      brokenRef.notifyEntitiesResult(msg.requestId, msg.docVersion, msg.results);
      break;
    }
    case 'scrollToPosition': {
      // C6b: file .md đã có panel mở sẵn — host gửi thẳng message này thay vì
      // qua 'init' vì resolveCustomTextEditor không chạy lại trong trường hợp này.
      if (msg.searchText) {
        // Bug General #1: entity link → reveal by whole-doc text search.
        lineGutter.scrollToText(msg.searchText);
      } else {
        lineGutter.scrollToSourceLine(msg.line + 1, msg.character, msg.length, msg.matchText);
      }
      break;
    }
    case 'configUpdate': {
      // Reading Mode (enabled/mode) KHÔNG áp qua configUpdate dù giờ global
      // (bug 0716 #2) — có kênh broadcast riêng ('readingModeChanged'), y hệt
      // Zen ('zenChanged', US-19.19). configUpdate chỉ phát khi user đổi
      // orcaEditor.* trong Settings, không phải lúc runtime toggle.
      lineNumbersEnabled = msg.showLineNumbers !== false;
      document.body.classList.toggle('md-line-numbers', lineNumbersEnabled);
      if (lineNumbersEnabled) {
        lineGutter.refreshFromDom();
      }
      // Chỉ auto-open khi cờ autoOpenToc đổi (vd. user vừa bật setting đó) —
      // KHÔNG bật lại TOC khi configUpdate đến vì đổi Reading/Focus/thứ khác.
      if (msg.autoOpenToc !== lastAutoOpenToc && shouldAutoOpenToc(msg.autoOpenToc)) {
        toc.toggle();
        syncTocButton();
      }
      lastAutoOpenToc = msg.autoOpenToc;
      // Req 21 US-21.5: live-toggle the trigger-actions visibility gate — the
      // one trigger.* field that changes at runtime (dateFormat/executeCommands
      // stay init-only, unchanged behavior).
      applyTriggerMode(msg.triggerMode);
      break;
    }
    case 'zenChanged': {
      // US-19.19: Zen vừa đổi ở TAB KHÁC, host broadcast lại — chỉ apply cục
      // bộ (applyZenFromHost không gọi lại onZenChange, tránh vòng lặp).
      readability.applyZenFromHost(msg.zen);
      break;
    }
    case 'readingModeChanged': {
      // Bug 0716 #2: enabled/mode vừa đổi ở TAB KHÁC, host broadcast
      // lại — chỉ apply cục bộ (applyReadingModeFromHost không gọi lại
      // onReadingModeChange, tránh vòng lặp).
      readability.applyReadingModeFromHost(msg);
      break;
    }
    case 'runCommand': {
      // Req 20 US-20.3: the `/` popup's Execute group, after the host validated
      // and ran vscode.commands.executeCommand — reuse the SAME local actions
      // the toolbar buttons already call (no parallel implementation).
      // toggle()/toggleZen() report back via onReadingModeChange/onZenChange
      // (postToHost above) exactly as when driven from the toolbar, so other
      // open tabs stay in sync.
      if (msg.command === 'toggleReadingMode') {
        readability.toggle();
      } else if (msg.command === 'toggleZen') {
        readability.toggleZen();
      } else if (msg.command === 'openToc') {
        toc.toggle();
        syncTocButton();
      }
      break;
    }
  }
});

postToHost({ type: 'ready' });

// Tab shrank below the width needed for the prose column + panel
// (isNarrowViewport, e.g. a split editor) → auto-hide the TOC so it doesn't
// crowd content. Only auto-hides on the wide→narrow TRANSITION — if the user
// re-opens the panel while the tab is still narrow, don't auto-close it again
// (respect their manual choice) until the next time it goes narrow.
let wasNarrowViewport = isNarrowViewport();
window.addEventListener('resize', () => {
  // Shrink the panel proportionally first, so the narrow-viewport check below
  // reads the reflowed --toc-width (panel shrinks, then auto-hides at the floor).
  toc.reflowWidth();
  const narrow = isNarrowViewport();
  if (narrow && !wasNarrowViewport && toc.isOpen()) {
    toc.toggle();
    syncTocButton();
  }
  wasNarrowViewport = narrow;
});

function applyPreviewFontSettings(cfg: Partial<InitConfig>): void {
  const root = document.documentElement;
  if (cfg.wordWrap) {
    document.body.classList.add('wordWrap');
  }
  if (typeof cfg.fontSize === 'number') {
    root.style.setProperty('--markdown-font-size', `${cfg.fontSize}px`);
  }
  if (typeof cfg.lineHeight === 'number') {
    root.style.setProperty('--markdown-line-height', String(cfg.lineHeight));
  }
  if (typeof cfg.fontFamily === 'string' && cfg.fontFamily.trim()) {
    root.style.setProperty('--markdown-font-family', String(cfg.fontFamily));
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderDocument(markdown: string): void {
  if (!renderer) {
    return;
  }
  currentText = markdown;
  const scrollTop = window.scrollY;
  const { html } = renderer.render(markdown);
  content.innerHTML = html;
  postProcessMathDom(content, document, renderer.getLastMathBlockRanges());
  postProcessMermaidDom(content, document);
  postProcessCodeHeaders(content, document);
  postProcessRelativePathLinks(content, document);
  postProcessCaptions(content, document);
  postProcessEntityRefs(content);
  postProcessEmptyLinks(content);
  ensureTrailingParagraph();
  ensureCaretSpotBeforeHr();
  mermaidView.renderAll();
  table.hideTableToolbar();
  // The rebuild above destroyed any row the row-menu was anchored to — close it (and release
  // its scroll lock), mirroring dragDrop.refresh() below for the block menu (bug General R2).
  table.closeRowMenu();
  if (lineNumbersEnabled) {
    lineGutter.refreshFromDom();
  }
  // Co từng cột bảng vừa dựng về vừa nội dung (cột ngắn không bị ép rộng bằng
  // sàn 14ch của cột dài nhất) — phải chạy TRƯỚC stickyTableHeader.refresh() vì
  // clone header đo bề rộng cột từ DOM tại thời điểm gọi.
  content.querySelectorAll('table').forEach((t) => fitTableColumns(t as HTMLTableElement));
  blockMap = buildBlockMap(content, markdown, blockMap);
  window.scrollTo({ top: scrollTop });
  saveScrollSoon();
  // Nội dung vừa dựng lại — range highlight cũ đã hỏng, tìm lại nếu đang mở.
  search.refresh();
  // Selection cũ (nếu có) đã mất ý nghĩa sau khi DOM đổi — dọn highlight.
  selectHighlight.refresh();
  // Vị trí icon/selection cũ không còn hợp lệ sau khi DOM đổi — ẩn icon/đóng popover.
  crossFileSearch.refresh();
  // The @// trigger popup anchors into #content just rebuilt — close it (no-op when
  // not open) so its orphaned card and the `trigger-popup-open` caret-suppression
  // class can't linger with the editor caret hidden (bug General: Mention Declare 3 & 4).
  triggerPopup.close();
  // Heading có thể đã đổi — dựng lại mục lục nếu panel đang mở.
  toc.refresh();
  // Req 20 US-20.9: anchors/headings just rebuilt — re-scan for broken references.
  brokenRef.refresh();
  // Bảng vừa dựng lại — bỏ cache header dính cũ, tính lại theo DOM mới.
  stickyTableHeader.refresh();
  // US-17.3: drop any in-flight drag / hover handle referencing now-stale nodes.
  dragDrop.refresh();
}

/**
 * Bug #3 — a host 'update' that arrived while a trigger popup owned the editor
 * keyboard, deferred until the popup releases input (see the `update` handler).
 * `baseText` is `currentText` at defer time: if a local edit (the popup's own
 * commit) has advanced `currentText` since, the deferred host text is stale and
 * dropped so the commit's DOM wins.
 */
interface PendingUpdate {
  text: string;
  caretLine?: number;
  caretCol?: number;
  baseText: string;
}
let pendingUpdate: PendingUpdate | undefined;

/** Render a host document 'update' and restore the caret (undo/redo carries an
 * explicit caretLine; a caret-less update snapshots the source caret and restores
 * it so it doesn't jump to the top of the file). */
function applyDocumentUpdate(text: string, caretLine?: number, caretCol?: number): void {
  const preservedCaret = caretLine === undefined ? captureCaretSource() : undefined;
  renderDocument(text);
  if (caretLine !== undefined) {
    restoreCaretAtSource(caretLine, caretCol ?? 0);
  } else if (preservedCaret) {
    restoreCaretAtSource(preservedCaret.line, preservedCaret.col);
  }
}

// Flush a deferred update when the trigger popup releases the editor keyboard.
onInputOwnerRelease(() => {
  const u = pendingUpdate;
  pendingUpdate = undefined;
  if (!u) {
    return;
  }
  // A local edit (e.g. the popup's own commit) advanced the doc since we
  // deferred → the deferred host text is stale; drop it, the local DOM wins.
  if (currentText !== u.baseText || u.text === currentText) {
    return;
  }
  applyDocumentUpdate(u.text, u.caretLine, u.caretCol);
});

/**
 * Sau khi render lại vì undo/redo, đặt caret về vị trí nguồn (`line` 1-based,
 * `col` 0-based) vừa đổi — KHÔNG cuộn (renderDocument đã giữ scrollTop). blockMap
 * luôn được dựng trong renderDocument (không phụ thuộc bật/tắt line numbers), nên
 * caret khôi phục được ở mọi chế độ.
 *
 * Với block ĐƠN DÒNG nguồn (đoạn văn/heading thường), cột nguồn = offset ký tự
 * trong text hiển thị của block, nên đặt đúng cột được (placeCaretAtOffsets tự
 * kẹp về cuối nếu vượt — vd. bỏ qua prefix "## " của heading). LIST đa dòng có
 * data-line riêng cho từng <li> nên vẫn đặt caret vào đúng bullet + cột. Block ĐA
 * DÒNG còn lại (bảng/blockquote/code) không map cột→DOM đơn giản → lùi về đầu block
 * (đủ để gõ tiếp đúng chỗ, đã tốt hơn hẳn mất caret).
 */
/**
 * Độ dài phần cú pháp markdown ở ĐẦU dòng nguồn của một block đơn dòng — heading
 * `#{1,6} `, blockquote `> `, bullet `-·*·+ `, ordered `1.·1) `, kèm ô task
 * `[ ]·[x] `. Render bỏ các ký hiệu này nên phải trừ ra khi suy cột nguồn →
 * offset trong text đã render. Không xử lý markup INLINE giữa dòng (`**đậm**`...)
 * — hiếm khi caret undo rơi vào đó, chấp nhận xấp xỉ.
 */
function sourcePrefixLen(mdSlice: string): number {
  // Anchored ^, nhánh rời nhau, không có quantifier lồng → không backtrack thảm
  // hoạ (safe-regex báo nhầm vì đếm số '+' liền nhau).
  // eslint-disable-next-line security/detect-unsafe-regex
  const m = /^(?:#{1,6} +|> ?|(?:[-*+]|\d+[.)]) +(?:\[[ xX]\] +)?)/.exec(mdSlice);
  return m ? m[0].length : 0;
}

/**
 * <li> lồng SÂU NHẤT có srcRange (data-line/data-line-end) chứa dòng nguồn `line`.
 * Một bullet cha và bullet con lồng trong nó cùng chứa dòng của con, nên chọn theo
 * số tổ tiên <li> lớn nhất để con thắng cha. Trả null nếu không bullet nào khớp.
 */
function deepestListItemAt(listEl: Element, line: number): Element | null {
  let best: Element | null = null;
  let bestDepth = -1;
  for (const li of Array.from(listEl.querySelectorAll('li'))) {
    const range = readSrcRange(li);
    if (!range || line < range.start || line > range.end) {
      continue;
    }
    let depth = 0;
    for (let p = li.parentElement; p && p !== listEl; p = p.parentElement) {
      if (p.tagName === 'LI') {
        depth++;
      }
    }
    if (depth > bestDepth) {
      best = li;
      bestDepth = depth;
    }
  }
  return best;
}

/**
 * Vị trí nguồn (line 1-based, col 0-based) của caret HIỆN TẠI trong #content,
 * suy từ blockMap của DOM đang hiển thị — nghịch đảo của restoreCaretAtSource.
 * Dùng để GIỮ caret qua một lần renderDocument mà host KHÔNG kèm caretLine (edit
 * do host tự ghi: Add reference/lệnh Execute sửa nội dung, hoặc external edit);
 * nếu không, DOM dựng lại làm caret bay về đầu file. Trả undefined khi không có
 * caret trong #content hoặc không map được block — khi đó caller không đụng caret.
 */
function captureCaretSource(): { line: number; col: number } | undefined {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    return undefined;
  }
  const node = sel.focusNode;
  if (!node || !content.contains(node)) {
    return undefined;
  }
  const entry = blockMap.find((b) => b.el.contains(node));
  if (!entry) {
    return undefined;
  }
  if (entry.srcRange.start === entry.srcRange.end) {
    // Block đơn dòng (đoạn văn/heading): cột nguồn = offset ký tự trong text render
    // + độ dài cú pháp đầu dòng (heading "## ", bullet "- "...) mà render đã bỏ —
    // đúng nghịch đảo của restoreCaretAtSource (renderedCol = col - sourcePrefixLen).
    const offset = getOffsetWithin(entry.el, node, sel.focusOffset);
    if (offset === null) {
      return { line: entry.srcRange.start, col: 0 };
    }
    return { line: entry.srcRange.start, col: offset + sourcePrefixLen(entry.mdSlice) };
  }
  // Block đa dòng (list/bảng/blockquote/code): caret trong một <li> mang data-line
  // riêng → lấy dòng của bullet đó (restoreCaretAtSource tự đặt về đầu bullet);
  // còn lại lùi về đầu block. Cột không map đơn giản → 0 (đủ để gõ tiếp đúng chỗ).
  const li = closestElement(node)?.closest('li');
  const liRange = li && entry.el.contains(li) ? readSrcRange(li) : null;
  return { line: liRange ? liRange.start : entry.srcRange.start, col: 0 };
}

function restoreCaretAtSource(line: number, col: number): void {
  if (blockMap.length === 0) {
    return;
  }
  const exact = blockMap.find((b) => line >= b.srcRange.start && line <= b.srcRange.end);
  if (exact && exact.srcRange.start === exact.srcRange.end) {
    // Cột nguồn tính cả cú pháp markdown ở đầu block (heading "##### ", bullet
    // "- ", ordered "1. ", task "[ ] ", blockquote "> ") mà text render đã bỏ —
    // trừ độ dài prefix đó để không vượt quá và bị kẹp về cuối block.
    const renderedCol = Math.max(0, col - sourcePrefixLen(exact.mdSlice));
    dom.placeCaretAtOffsets(exact.el, renderedCol, renderedCol);
    return;
  }
  if (exact) {
    // List đa dòng: Block Map chỉ giữ cả <ul>/<ol> (start !== end) nên nhánh cột
    // chính xác ở trên bị bỏ qua và caret sẽ rơi về ĐẦU list. Nhưng mỗi <li> mang
    // data-line riêng (render.ts) → tìm đúng bullet đang sửa và đặt caret theo cột
    // trong bullet đó, thay vì collapse về bullet đầu.
    const li = deepestListItemAt(exact.el, line);
    if (li) {
      const liRange = readSrcRange(li);
      // Chỉ suy cột khi <li> chỉ chiếm ĐÚNG một dòng nguồn: khi đó cột nguồn của
      // dòng = offset ký tự trong text của li. Li ĐA DÒNG (bullet wrap, item nhiều
      // đoạn, item chứa block con/sublist) có text = nhiều dòng ghép lại nên cột
      // theo-dòng lệch hệ quy chiếu với offset-toàn-li của placeCaretAtOffsets →
      // dễ rơi sai chỗ/lọt sang bullet con; lùi về đầu li (đúng bullet, hơn hẳn về
      // đầu cả list).
      if (liRange && liRange.start === liRange.end) {
        const srcLine = currentText.split('\n')[line - 1] ?? '';
        const indentLen = srcLine.length - srcLine.trimStart().length;
        const renderedCol = Math.max(0, col - indentLen - sourcePrefixLen(srcLine.slice(indentLen)));
        dom.placeCaretAtOffsets(li, renderedCol, renderedCol);
      } else {
        dom.placeCaretIn(li);
      }
      return;
    }
    dom.placeCaretIn(exact.el);
    return;
  }
  // Dòng không rơi đúng block nào (vd. nội dung ở đó vừa bị undo xoá) → block
  // gần nhất bắt đầu từ trên dòng đó, hoặc block đầu tiên nếu không có.
  let fallback = blockMap[0];
  for (const b of blockMap) {
    if (b.srcRange.start <= line) {
      fallback = b;
    }
  }
  dom.placeCaretIn(fallback.el);
}

/**
 * contentEditable cần ít nhất một block để đặt caret. Ngoài ra, nếu phần tử
 * CUỐI là khối "atom"/"bẫy caret" — Mermaid, công thức, front matter, code
 * block, bảng, <hr> — thì không có chỗ đặt con trỏ ngay phía sau nó nên không
 * thể thêm nội dung mới xuống dưới (Mermaid ở chế độ biểu đồ là nặng nhất:
 * toàn bộ vùng nhìn thấy đều contenteditable=false). Đảm bảo luôn có một <p>
 * rỗng ở cuối để làm "chỗ thoát".
 *
 * An toàn với serialize: rule 'emptyParagraph' của turndown bỏ mọi <p> rỗng
 * khi lưu (xem pipeline.ts) nên <p> thêm vào KHÔNG làm đổi Markdown, không gây
 * sync/diff giả.
 */
const TRAILING_TRAP_SELECTOR =
  '.md-mermaid, .md-math-block, .md-front-matter, pre, table, hr, [contenteditable="false"]';

function ensureTrailingParagraph(): void {
  const last = content.lastElementChild;
  if (!last) {
    content.innerHTML = '<p><br></p>';
    return;
  }
  if (last.matches(TRAILING_TRAP_SELECTOR)) {
    content.appendChild(emptyParagraph());
  }
}

/**
 * Khối "atom" toàn phần: mọi vùng nhìn thấy đều contenteditable=false, nên
 * KHÔNG có vị trí caret nào bên trong lẫn "ngay sau" nó nếu phần tử kế tiếp
 * cũng là một khối bẫy caret (hoặc không có phần tử kế tiếp — trường hợp con
 * cuối của blockquote/li, nơi ensureTrailingParagraph không với tới).
 */
const ATOM_BLOCK_SELECTOR = '.md-mermaid, .md-math-block';

/**
 * Đảm bảo SAU MỖI khối Mermaid/math block đều có chỗ đặt caret: nếu phần tử
 * kế tiếp không phải block gõ được (hoặc không tồn tại) thì chèn một <p> rỗng
 * ngay sau. Cùng lý do an-toàn-serialize với ensureTrailingParagraph: <p> rỗng
 * bị rule 'emptyParagraph' của turndown bỏ khi lưu nên không đổi Markdown.
 */
function ensureCaretSpotAfterAtomBlocks(): void {
  for (const atom of Array.from(content.querySelectorAll(ATOM_BLOCK_SELECTOR))) {
    const next = atom.nextElementSibling;
    if (!next || next.matches(TRAILING_TRAP_SELECTOR)) {
      atom.parentNode?.insertBefore(emptyParagraph(), atom.nextSibling);
    }
  }
}

/**
 * Một <hr> giữa tài liệu thường bị kẹp ngay dưới một heading/khối khác, và dòng
 * trắng CommonMark ở phía trên nó KHÔNG sinh ra node DOM nào (blank line = không
 * có <p>). Click vào khoảng hở phía trên <hr> vì thế rơi thẳng về #content root:
 * input rule `>` (input-rules.ts) và formatHeading (toolbar.ts) mất block đích,
 * execCommand native "nuốt" luôn chính cái <hr> kề bên (Bug #7/#9, HLR 22 Phase
 * 2). Đảm bảo LUÔN có một <p> rỗng ngay TRƯỚC mỗi <hr> cấp cao nhất để click vào
 * khoảng hở đó có chỗ đặt caret hợp lệ.
 *
 * Cùng lý do an-toàn-serialize với ensureTrailingParagraph: <p> rỗng bị rule
 * 'emptyParagraph' của turndown bỏ khi lưu, và buildBlockMap bỏ qua <p> không có
 * src-range nên không lệch Block Map / số dòng.
 */
function ensureCaretSpotBeforeHr(): void {
  for (const hr of Array.from(content.querySelectorAll(':scope > hr'))) {
    const prev = hr.previousElementSibling;
    const alreadyTrapped = prev?.nodeName === 'P' && (prev.textContent ?? '').trim() === '';
    if (!alreadyTrapped) {
      hr.parentNode?.insertBefore(emptyParagraph(), hr);
    }
  }
}

// ---------------------------------------------------------------------------
// Serialize + đồng bộ về extension
// ---------------------------------------------------------------------------

function scheduleSync(): void {
  if (syncTimer !== undefined) {
    clearTimeout(syncTimer);
  }
  syncTimer = setTimeout(syncNow, SYNC_DEBOUNCE_MS);
  // Any content mutation may have added/removed/retitled a heading. Raw-DOM
  // toolbar ops (formatHeading's replaceBlockTag, list/blockquote conversions)
  // call scheduleSync but never fire an 'input' event, so refreshing here — not
  // only in the 'input' handler — is the single place that keeps the TOC in sync
  // for BOTH keyboard edits and toolbar actions. (renderDocument refreshes on
  // its own for host-driven re-renders, which don't go through scheduleSync.)
  toc.refresh();
  // Same reasoning as toc.refresh() above — a link's href/text or a heading's
  // text may have just changed (Req 20 US-20.9).
  brokenRef.refresh();
}

// Ctrl/Cmd inline-format shortcut body shared by bold/italic/inline-code/
// strikethrough: swallow the browser default, run the format, then schedule a
// sync. `apply` is a thunk so it covers both execCommand and toggleInlineCode.
function applyInlineFormat(e: KeyboardEvent, apply: () => void): void {
  e.preventDefault();
  apply();
  scheduleSync();
}

// Vẫn phải turndown để có markdown mà so sánh, nhưng chỉ khi nội dung THỰC SỰ
// đổi mới parse lại gutter (markdown-it lần 2) + cập nhật currentText — bỏ hẳn
// hai bước này ở nhịp debounce mà nội dung không đổi (finding P-03). Trả markdown
// mới, hoặc undefined khi không đổi. Lõi chung của syncNow/takePendingSync; mỗi
// hàm giữ prologue timer + đuôi riêng (post vs. return).
function serializeIfChanged(): string | undefined {
  const markdown = serialize();
  if (markdown === currentText) {
    return undefined;
  }
  if (lineNumbersEnabled) {
    lineGutter.refreshFromMarkdown(markdown);
  }
  currentText = markdown;
  return markdown;
}

function syncNow(): void {
  // syncNow is also called directly (invokeAction's post-action sync in
  // toolbar.ts) while a debounce timer armed DURING the action (execCommand's
  // synchronous 'input' event → scheduleSync) may still be live — cancel it,
  // or it fires up to 250ms later as an orphan no longer referenced by
  // syncTimer: it can commit a partial word as its own undo unit and every
  // scheduleSync after it re-orphans the next timer.
  if (syncTimer !== undefined) {
    clearTimeout(syncTimer);
  }
  syncTimer = undefined;
  const markdown = serializeIfChanged();
  if (markdown !== undefined) {
    postToHost({ type: 'edit', text: markdown });
  }
}

/**
 * Nếu còn thay đổi đang chờ debounce, serialize NGAY và trả về markdown (đồng
 * thời cập nhật currentText + gutter như syncNow, nhưng KHÔNG postToHost). Dùng
 * cho undo/redo: gắn kèm markdown này vào message để host commit lần gõ mới nhất
 * thành 1 undo-unit rồi mới undo — atomic trong một handler ở host. Trả undefined
 * khi không có gì đang chờ (nội dung đã đồng bộ).
 */
function takePendingSync(): string | undefined {
  if (syncTimer === undefined) {
    return undefined;
  }
  clearTimeout(syncTimer);
  syncTimer = undefined;
  return serializeIfChanged();
}

function serialize(): string {
  const clone = content.cloneNode(true) as HTMLElement;
  // cloneNode không copy property 'checked' — đồng bộ từ DOM thật sang attribute.
  const liveInputs = content.querySelectorAll('input[type="checkbox"]');
  const cloneInputs = clone.querySelectorAll('input[type="checkbox"]');
  liveInputs.forEach((live, i) => {
    const c = cloneInputs[i];
    if (!c) {
      return;
    }
    c.toggleAttribute('checked', (live as HTMLInputElement).checked);
  });
  prepareDomForSerialize(clone, document);
  applyBlockStyleOverrides(clone);
  const md = turndown.turndown(clone);
  return normalizeMarkdown(md);
}

/**
 * US-18.4a: before turndown runs, stamp each block's ORIGINAL style override onto
 * the clone so serialize keeps every block's initial `.md` syntax variant instead
 * of forcing the global style. Blocks are matched via `data-block-id` (stamped on
 * the live DOM by the Block Map, preserved by cloneNode) and the variant is
 * detected from `mdSlice`. A block with no mdSlice (new content) or an axis not
 * yet supported gets nothing stamped and falls through to the default. This is
 * shared infrastructure: US-18.4b extends detectBlockStyle/stampStyleOverride, it
 * does not rebuild this loop.
 */
function applyBlockStyleOverrides(clone: HTMLElement): void {
  for (const entry of blockMap) {
    if (!entry.mdSlice) {
      continue;
    }
    const el = clone.querySelector(`[${BLOCK_ID_ATTR}="${entry.id}"]`);
    if (!el) {
      continue;
    }
    const style = detectBlockStyle(entry.mdSlice, entry.type);
    // US-4.28: a block whose language the user switched in place must not be
    // re-forced back to its ORIGINAL indented syntax — indented code can't carry
    // a language, so turndown would drop the pick. Drop the code axis so it
    // serializes as a fence (only indented needs this; tilde fences keep a lang).
    if (el.hasAttribute(LANG_SWITCHED_ATTR) && (style.code === 'indented' || style.code === 'indented-tab')) {
      style.code = null;
    }
    stampStyleOverride(el, style);
  }
}

// ---------------------------------------------------------------------------
// Sự kiện chỉnh sửa
// ---------------------------------------------------------------------------

/**
 * Chỉ những inputType này (xoá/cắt/undo/redo/dán) mới có thể sinh ra lỗi
 * "orphan nested list" của Chromium (xem fixOrphanNestedListItems). Gõ chữ
 * bình thường (insertText...) không bao giờ tạo cấu trúc này nên bỏ qua để
 * không quét querySelectorAll('li') toàn tài liệu mỗi keystroke (finding P-04).
 */
const ORPHAN_LIST_INPUT_TYPES = new Set([
  'deleteContentBackward',
  'deleteContentForward',
  'deleteByCut',
  'historyUndo',
  'historyRedo',
  'insertFromPaste',
]);

/**
 * true nếu caret (collapsed) đang đứng ngay sau một ký tự khoảng trắng trong
 * text node hiện tại — dùng để dò ranh giới TỪ độc lập với inputType/data
 * (xem chú thích ở content 'input' listener, bug 0717b).
 */
function caretPrecededByWhitespace(): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) {
    return false;
  }
  const { startContainer, startOffset } = sel.getRangeAt(0);
  if (startContainer.nodeType !== Node.TEXT_NODE || startOffset === 0) {
    return false;
  }
  return /\s/.test((startContainer.textContent ?? '').charAt(startOffset - 1));
}

content.addEventListener('input', (e) => {
  // inputType rỗng (một số trình duyệt/thao tác không đặt) → quét cho chắc.
  const inputType = (e as InputEvent).inputType;
  if (!inputType || ORPHAN_LIST_INPUT_TYPES.has(inputType)) {
    fixOrphanNestedListItems();
  }
  scheduleSync();
  // Commit một undo-checkpoint ở ranh giới TỪ (space/Enter): mỗi từ thành 1 edit
  // = 1 bước undo (giống mọi editor), thay vì cả cụm gõ liên tục dồn thành một
  // undo-unit. Nếu không, granularity undo phụ thuộc nhịp gõ so với debounce
  // 250ms (gõ nhanh không nghỉ → debounce không fire → 1 undo xoá sạch).
  //
  // Bug 0717b: dò ranh giới qua inputType==='insertText' + data đúng 1 ký tự
  // khoảng trắng KHÔNG đáng tin với chữ Việt có dấu — bộ gõ (Telex/VNI, kể cả
  // IME hệ điều hành) thường tạo tổ hợp sự kiện composition hoặc xoá-gõ-lại
  // nhiều ký tự một lúc để ráp dấu, nên "data" hiếm khi còn là 1 ký tự khoảng
  // trắng đơn thuần — flush bị bỏ lỡ, nhiều từ dồn chung một debounce, undo
  // gộp cả cụm từ. Đọc thẳng ký tự ngay trước caret trong DOM (chỉ khi
  // composition đã kết thúc — !isComposing) để nhận diện đúng "vừa gõ xong
  // một khoảng trắng", bất kể trình duyệt tạo ra ký tự đó bằng cơ chế nào.
  if (
    inputType === 'insertParagraph' ||
    inputType === 'insertLineBreak' ||
    (!(e as InputEvent).isComposing && caretPrecededByWhitespace())
  ) {
    flushPendingSync();
  }
  search.refresh();
  // toc.refresh() intentionally omitted here — scheduleSync() above already
  // refreshes the TOC for every content mutation (see scheduleSync).
  // Bug #1 (mở rộng): mọi edit đều có thể dồn/dời block, để lại drag/hover handle
  // (position:fixed) đứng sai chỗ tới lần di chuột kế. Handle là affordance của
  // chuột nên ẩn khi gõ, tự hiện lại khi onContentHover chạy lúc di chuột. refresh()
  // với null không đọc layout nên an toàn cho hot handler này. (Nếu có ai vừa kéo
  // vừa gõ, refresh() cũng huỷ luôn thao tác kéo dở — chấp nhận được: block-move
  // dùng Range API không bắn 'input' nên một lần kéo bình thường không tự huỷ.)
  dragDrop.refresh();
  // Gõ trong ô bảng có thể đổi bề rộng cột (auto-layout co/giãn theo nội dung) —
  // clone header dính (nếu đang hiện) cache bề rộng cột cũ, không tự nhận ra
  // thay đổi này (chỉ dựng lại khi ĐỔI bảng, xem table-sticky-header.ts), gây
  // lệch cột với header thật. Refresh để lần update() kế tiếp dựng lại clone.
  if ((e.target as Element | null)?.closest?.('table')) {
    stickyTableHeader.refresh();
  }
});

/**
 * Sửa lỗi Chromium: xoá, cắt (Cmd/Ctrl+X) hoặc undo/redo đè lên ranh giới giữa
 * text của một mục list và danh sách con lồng ngay trong mục đó có thể tách
 * nhầm danh sách con ra một <li> rỗng đứng SAU — nhìn như bullet con "nhảy"
 * xuống dòng dưới (xem findOrphanNestedListPair trong pipeline.ts, dùng chung
 * với normalizeListDom lúc serialize). Chạy lại sau MỌI sự kiện input để tự
 * sửa ngay trên DOM đang hiển thị — kể cả sau khi chính execCommand('undo')
 * của trình duyệt tái diễn lỗi tương tự.
 *
 * Phải sửa qua execCommand('insertHTML') chứ không appendChild/remove trần:
 * thao tác DOM trần tuy sửa được cấu trúc ngay lúc đó nhưng làm lịch sử
 * undo/redo gốc của trình duyệt tham chiếu tới node đã bị dọn đi — Cmd+Z ngay
 * sau đó dựng lại cây rác (mất nội dung) thay vì phục hồi đúng trạng thái
 * trước lệnh xoá gốc (đã kiểm chứng thủ công: appendChild/remove trần khiến
 * undo lần đầu cho ra kết quả sai hẳn cấu trúc/nội dung; qua execCommand thì
 * undo lần 1 lùi về đúng bước xoá gốc (còn lỗi), undo lần 2 phục hồi đúng y hệt
 * nội dung ban đầu).
 */
function fixOrphanNestedListItems(): void {
  let guard = 0;
  for (;;) {
    const pair = findOrphanNestedListPair(content);
    if (!pair || ++guard > 50) {
      return;
    }
    const mergedHtml = pair.prev.innerHTML + (pair.nested as HTMLElement).outerHTML;
    const range = document.createRange();
    range.setStartBefore(pair.prev);
    range.setEndAfter(pair.wrapper);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.execCommand('insertHTML', false, `<li>${mergedHtml}</li>`);
  }
}

// Trước khi unload/ẩn/mất focus — đẩy nốt thay đổi đang chờ.
function flushPendingSync(): void {
  if (syncTimer !== undefined) {
    clearTimeout(syncTimer);
    syncNow();
  }
}

window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushPendingSync();
  }
});
window.addEventListener('blur', flushPendingSync);
window.addEventListener('pagehide', flushPendingSync);

// Copy/cut: mặc định trình duyệt lấy text/plain của vùng chọn theo cách riêng
// (bảng → cột cách nhau bằng tab, không phải cú pháp pipe "| a | b |"); dán
// lại (qua handler 'paste' bên dưới, chỉ đọc text/plain rồi render bằng
// markdown-it) sẽ mất hẳn cấu trúc bảng/list. Ghi đè text/plain bằng chính
// Markdown (cùng turndown dùng để lưu file) của đúng vùng đang chọn — copy
// rồi paste vào editor luôn giữ đúng định dạng. Copy handler còn ghi kèm
// text/html (xem copySelectionAsMarkdown) để dán ra công cụ rich text bên
// ngoài cũng giữ format.
function selectionAsMarkdown(): string | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    return null;
  }
  const wrapper = document.createElement('div');
  wrapper.appendChild(sel.getRangeAt(0).cloneContents());
  prepareDomForSerialize(wrapper, document);
  const md = normalizeMarkdown(turndown.turndown(wrapper));
  return md.trim() ? md : null;
}

function copySelectionAsMarkdown(e: ClipboardEvent): boolean {
  const md = selectionAsMarkdown();
  if (md === null) {
    return false;
  }
  e.preventDefault();
  e.clipboardData?.setData('text/plain', md);
  // Ngoài text/plain (Markdown, để dán ngược vào editor vẫn convert đúng), ghi
  // thêm text/html render từ chính Markdown đó — công cụ nhận rich text bên
  // ngoài (email, Word, Google Docs...) ưu tiên text/html nên giữ được định
  // dạng như trên editor thay vì phơi ra cú pháp .md thô. Handler 'paste' của
  // editor chỉ đọc text/plain nên nhánh dán-lại-vào-editor không bị ảnh hưởng.
  const html = renderPasteHtml(md);
  if (html) {
    e.clipboardData?.setData('text/html', html);
  }
  return true;
}

content.addEventListener('copy', copySelectionAsMarkdown);

content.addEventListener('cut', (e) => {
  if (copySelectionAsMarkdown(e)) {
    document.execCommand('delete');
    scheduleSync();
  }
});

// Document Blocks item 8: per-code-block "Copy" button. One delegated listener
// for every header injected by postProcessCodeHeaders — copies the block's raw
// code (trailing newline trimmed) and briefly flips the label to "Copied".
content.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement)?.closest?.('.' + MD_CODE_COPY_CLASS) as HTMLElement | null;
  if (!btn) {
    return;
  }
  const code = btn.closest('pre')?.querySelector('code');
  if (!code) {
    return;
  }
  const text = (code.textContent ?? '').replace(/\n$/, '');
  if (!navigator.clipboard) {
    return; // No Clipboard API in this context — nothing to do (avoid a sync throw).
  }
  navigator.clipboard
    .writeText(text)
    .then(() => {
      btn.textContent = 'Copied';
      window.setTimeout(() => {
        btn.textContent = 'Copy';
      }, 1200);
    })
    .catch(() => {
      /* No clipboard-write permission — leave the button unchanged. */
    });
});

// US-4.28: keep the caret/selection in #content when the language label is
// clicked — like every real toolbar trigger (wireTriggerButton in toolbar.ts),
// preventDefault on mousedown so clicking the label doesn't blur/collapse the
// selection (else a follow-up keyboard undo may not target the editor).
content.addEventListener('mousedown', (e) => {
  if ((e.target as HTMLElement)?.closest?.('.' + MD_CODE_LANG_CLASS)) {
    e.preventDefault();
  }
});

// Per-code-block word-wrap toggle. One delegated listener for every "Wrap"
// button injected by postProcessCodeHeaders — toggles MD_CODE_WRAPPED_CLASS on
// the block's <pre> (default ON) and keeps aria-pressed in sync. UI-only state,
// never serialized (turndown reads only <code>), so no 'edit' is emitted.
content.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement)?.closest?.('.' + MD_CODE_WRAP_CLASS) as HTMLElement | null;
  if (!btn) {
    return;
  }
  const pre = btn.closest('pre');
  if (!pre) {
    return;
  }
  const wrapped = pre.classList.toggle(MD_CODE_WRAPPED_CLASS);
  btn.setAttribute('aria-pressed', String(wrapped));
});

// US-4.28: in-place language switcher. One delegated listener for every code
// header's language label injected by postProcessCodeHeaders — clicking it opens
// the same 9-language dropdown as the toolbar's code-block button and rewrites
// the block's language in place (see openCodeLangSwitcher in toolbar.ts).
content.addEventListener('click', (e) => {
  const label = (e.target as HTMLElement)?.closest?.('.' + MD_CODE_LANG_CLASS) as HTMLElement | null;
  if (!label) {
    return;
  }
  openCodeLangSwitcher(label);
});

/**
 * Fallback cho Cmd/Ctrl+X (giống pasteFromClipboardApi cho Cmd/Ctrl+V): iframe
 * webview lồng nhau của VS Code custom editor không phải lúc nào cũng bắn sự
 * kiện 'cut' kèm clipboardData khi phím tắt được gõ — khi đó handler 'cut' ở
 * trên không chạy nên Cmd+X không cắt được gì. Dùng thẳng async Clipboard API
 * (VS Code cấp quyền cho webview) để ghi Markdown của vùng chọn vào clipboard,
 * rồi xoá vùng chọn. Trả về false nếu không có gì để cắt (để không preventDefault
 * thừa). Ghi clipboard là async nhưng `md` đã chốt trước khi xoá nên không race.
 */
function cutSelectionViaClipboardApi(): boolean {
  const md = selectionAsMarkdown();
  if (md === null) {
    return false;
  }
  navigator.clipboard.writeText(md).catch(() => {
    /* Không có quyền clipboard-write — handler 'cut' event ở trên lo trường hợp còn lại. */
  });
  document.execCommand('delete');
  scheduleSync();
  return true;
}

// Paste: chỉ lấy text/plain (tránh dán HTML bừa từ ngoài vào làm hỏng cấu
// trúc), rồi render lại bằng chính markdown-it của app. Nếu chèn thẳng làm
// text thô, cú pháp Markdown copy từ file .md khác (**bold**, # heading,
// `code`, [link](...)...) sẽ nằm lại như text thường; khi serialize ngược về
// Markdown, turndown sẽ escape các ký tự đó (\*\*bold\*\*...) để giữ nguyên ý
// "đây là text thường" — kết quả là toàn bộ format bị chèn thêm dấu \ và vỡ.
content.addEventListener('paste', (e) => {
  e.preventDefault();
  if (pasteImage.handlePasteEvent(e)) {
    return;
  }
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (text) {
    insertPastedMarkdown(text);
  }
});

/**
 * Fallback cho Cmd/Ctrl+V: iframe webview lồng nhau của VS Code custom editor
 * không phải lúc nào cũng bắn sự kiện 'paste' kèm clipboardData khi phím tắt
 * được gõ (khác với Paste qua menu chuột phải, vẫn đi qua handler ở trên).
 * Dùng thẳng async Clipboard API — vốn được VS Code cấp quyền cho webview —
 * làm đường dự phòng độc lập với cơ chế 'paste' event của trình duyệt.
 */
function pasteFromClipboardApi(): void {
  void pasteImage.tryPasteImageFromClipboardApi().then((handledImage) => {
    if (handledImage) {
      return;
    }
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text) {
          insertPastedMarkdown(text);
        }
      })
      .catch(() => {
        /* Không có quyền clipboard-read — bỏ qua, đã có handler 'paste' ở trên lo trường hợp còn lại. */
      });
  });
}

// Bug #8 smart gap: khi dán chữ inline ngay sát một từ có sẵn ("foo" + dán
// "bar") thì chèn một space ngăn cách để không dính thành "foobar". Chỉ chèn
// cạnh ký tự "chữ" thực — bỏ qua khi hàng xóm là khoảng trắng hoặc dấu câu
// (giống thói quen gõ tay: "(x)" không thêm space, "word," không thêm space).
const SMART_GAP_SUPPRESS_PUNCT = new Set(['(', '[', '{', '"', "'", ')', ']', '}', ',', '.', ';', ':', '!', '?']);

// Thẻ block-level ở tầng trên cùng của fragment vừa render — sự hiện diện của
// một trong số này nghĩa là dán "block" (heading/list/quote/code/table...),
// KHÔNG áp smart gap (một space đầu dòng phá cú pháp "# heading").
const BLOCK_LEVEL_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'PRE',
  'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'HR', 'DIV', 'SECTION', 'FIGURE',
]);

function isInlinePasteFragment(html: string): boolean {
  const probe = document.createElement('div');
  probe.innerHTML = html;
  return !Array.from(probe.children).some((el) => BLOCK_LEVEL_TAGS.has(el.tagName));
}

// true nếu `ch` là hàng xóm cần chèn gap: tồn tại, không phải khoảng trắng, và
// không phải dấu câu trong danh sách suppress.
function needsSmartGap(ch: string): boolean {
  return ch !== '' && !/\s/.test(ch) && !SMART_GAP_SUPPRESS_PUNCT.has(ch);
}

// Block giữ MỘT dòng logic — đọc ký tự kề caret phải giới hạn trong đây, không
// tràn sang <li>/<td> anh em cùng một <ul>/<table> (leo lên tầng trên cùng của
// #content sẽ gộp cả list/table thành một "block" và bleed qua ranh giới dòng).
const GAP_LINE_BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, td, th, dt, dd, blockquote, figcaption';

/**
 * Bug #8: với dán inline tại caret thu gọn (không nằm trong pre/code), thêm một
 * gap trước/sau chỗ chèn nếu ký tự liền kề caret là "chữ" thực. `text` là chuỗi
 * dán thô — mép của chính nó cũng phải "chữ" thì mới chèn gap phía đó (dán
 * ",bar" cạnh "foo" không được thành "foo ,bar"). Dùng NBSP (\u00A0) thay vì
 * space ASCII vì `execCommand('insertHTML')` của Chromium nuốt một space ASCII
 * đứng ngay trước caret (xem toolbar.ts runTriggerInsertDate); NBSP không bị
 * nuốt và `normalizeNbsp` (dom-serialize-prep.ts) chuyển ngược NBSP -> space
 * ASCII khi lưu, nên .md ra đúng một space thường. Gộp cả gap vào một lần
 * insertHTML để giữ một bước undo.
 */
function applySmartGap(html: string, text: string): string {
  if (!isInlinePasteFragment(html)) {
    return html;
  }
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) {
    return html;
  }
  const range = sel.getRangeAt(0);
  const block = closestElement(range.startContainer)?.closest(GAP_LINE_BLOCK_SELECTOR);
  if (!block || block.closest('pre, code') || !content.contains(block)) {
    return html;
  }
  const before = textBeforeCaret(block, range).slice(-1);
  const after = textAfterCaret(block, range).slice(0, 1);
  const NBSP = '\u00A0';
  let out = html;
  // Chỉ chèn gap khi CẢ hàng xóm CẢ mép tương ứng của text dán đều là "chữ".
  if (needsSmartGap(before) && needsSmartGap(text.charAt(0))) {
    out = NBSP + out;
  }
  if (needsSmartGap(after) && needsSmartGap(text.charAt(text.length - 1))) {
    out = out + NBSP;
  }
  return out;
}

function insertPastedMarkdown(text: string): void {
  const html = renderPasteHtml(text);
  if (!html) {
    document.execCommand('insertText', false, text);
    return;
  }
  document.execCommand('insertHTML', false, applySmartGap(html, text));
  // Có thể vừa chèn một khối ```mermaid``` mới — dựng SVG cho nó (renderAll
  // quét lại toàn bộ content nên cũng vô hại với các biểu đồ có sẵn, chỉ tốn
  // thêm chút công tính lại chứ không phá cấu trúc).
  mermaidView.renderAll();
}

/**
 * Chèn markdown tại vị trí caret hiện tại — dùng cho toolbar (Math US-4.11,
 * Mermaid US-4.12), khác "dán" chỉ ở tên gọi/ngữ cảnh gọi: text luôn là một
 * mảnh nhỏ tự sinh (vd. `$x^2$`, fence ```mermaid```), nên tái dùng nguyên
 * pipeline renderPasteHtml → insertHTML → mermaidView.renderAll() của
 * insertPastedMarkdown, cộng thêm một bước riêng cho khối atom (Mermaid /
 * math block): chèn kèm <p> rỗng ngay sau khối để caret có chỗ đứng gõ tiếp
 * (cùng pattern với nút HR/Code block/Table — insertHTML đặt caret vào block
 * cuối của chuỗi chèn), rồi rà lại TẤT CẢ khối atom trong tài liệu — chèn
 * ngay cạnh một khối Mermaid có sẵn sẽ làm hai khối dính nhau, không còn chỗ
 * click caret vào giữa.
 */
function insertMarkdownAtCaret(text: string): void {
  const html = renderPasteHtml(text);
  if (!html) {
    document.execCommand('insertText', false, text);
    return;
  }
  const probe = document.createElement('div');
  probe.innerHTML = html;
  const endsWithAtom = probe.lastElementChild?.matches(ATOM_BLOCK_SELECTOR) ?? false;
  document.execCommand('insertHTML', false, endsWithAtom ? `${html}<p><br></p>` : html);
  if (endsWithAtom) {
    ensureCaretSpotAfterAtomBlocks();
  }
  mermaidView.renderAll();
}

/**
 * Render text vừa dán thành HTML để chèn. Nếu kết quả chỉ là một <p> duy nhất
 * (dán một dòng giữa câu, không có cú pháp block nào) thì bóc thẻ <p> ra —
 * tránh tạo ngắt đoạn ngoài ý muốn khi dán chữ thường vào giữa văn bản.
 *
 * postProcessMathDom/postProcessMermaidDom phải chạy trên `tmp` (fragment
 * rời, tách biệt) chứ KHÔNG được chạy trên `content` (DOM sống): hai hàm này
 * bọc thêm wrapper quanh mỗi <span class="katex">/<code class="language-
 * mermaid"> tìm thấy mà không kiểm tra đã bọc hay chưa — chạy lại trên toàn
 * bộ content sẽ bọc chồng (double-wrap) luôn cả những khối math/mermaid đã có
 * sẵn từ trước trong tài liệu, không chỉ đoạn vừa dán.
 */
function renderPasteHtml(text: string): string {
  if (!renderer) {
    return '';
  }
  const { html } = renderer.render(text);
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  postProcessMathDom(tmp, document, renderer.getLastMathBlockRanges());
  postProcessMermaidDom(tmp, document);
  postProcessCodeHeaders(tmp, document);
  if (tmp.children.length === 1 && tmp.firstElementChild?.tagName === 'P') {
    return tmp.firstElementChild.innerHTML;
  }
  return tmp.innerHTML;
}

// Checkbox task list: toggle bằng chuột.
content.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target instanceof HTMLInputElement && target.type === 'checkbox') {
    // KHÔNG preventDefault: click mặc định đã tự toggle target.checked. Nếu
    // preventDefault (như trước đây), spec bắt buộc browser revert lại
    // .checked về giá trị trước click sau khi dispatch xong — attribute thì
    // đã set nhưng property bị revert nên checkbox không đổi trạng thái hiển
    // thị/tương tác được (đúng lỗi user báo). Ở đây chỉ đồng bộ attribute
    // theo property đã được browser toggle sẵn.
    target.toggleAttribute('checked', target.checked);
    scheduleSync();
    return;
  }
  // Click vào ảnh: trình duyệt mặc định "chọn ảnh như object" (không có vị
  // trí caret bên trong ảnh) khiến người dùng không Enter xuống dòng được
  // ngay sau ảnh. Đặt caret ngay bên phải ảnh thay vào đó. Bỏ qua khi giữ
  // Cmd/Ctrl để click ảnh nằm trong link vẫn mở link như bình thường (nhánh anchor bên dưới).
  const img = target.closest('img');
  if (img && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    dom.placeCaretAfter(img);
    return;
  }
  // Cmd/Ctrl+Click mở liên kết. Luôn chặn cả preventDefault lẫn propagation:
  // preload của VS Code webview có listener click ở document sẽ resolve href
  // qua <base> (https://file+.vscode-resource...) rồi mở ra BROWSER nếu sự
  // kiện lọt tới nó — kể cả khi mình đã preventDefault.
  const anchor = target.closest('a');
  if (anchor) {
    e.preventDefault();
    e.stopPropagation();
    // US-20.5: a plain click on a `## References` entry is navigation, not
    // link-open — broken (⚠️) → jump to first body occurrence; healthy → open
    // its target. Cmd/Ctrl+Click on a References entry still opens normally.
    if (!e.metaKey && !e.ctrlKey && referencesSectionAnchors().has(anchor)) {
      navigateReferenceEntry(anchor);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      openLink(anchor.getAttribute('href') ?? '');
    }
    return;
  }
  // Inline code span marked as a relative path (bug General #5) — clickable but
  // NOT wrapped in <a> (that would corrupt the code span's round-trip). Only act
  // on Cmd/Ctrl+Click; a plain click must still place the caret for editing.
  const codeLink = target.closest(`code[${AUTOLINK_PATH_ATTR}]`);
  if (codeLink && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    e.stopPropagation();
    openLink(encodeLinkPath(codeLink.getAttribute(AUTOLINK_PATH_ATTR) ?? ''));
  }
});

// Middle-click (auxclick) cũng bị preload mở ra browser — chặn nốt.
content.addEventListener('auxclick', (e) => {
  if ((e.target as HTMLElement).closest('a')) {
    e.preventDefault();
    e.stopPropagation();
  }
});

function openLink(href: string): void {
  if (!href) {
    return;
  }
  if (href.startsWith('#')) {
    scrollToAnchor(href.slice(1));
    return;
  }
  postToHost({ type: 'openLink', href });
}

function scrollToAnchor(fragment: string): void {
  const decoded = decodeURIComponent(fragment).toLowerCase();
  const headings = content.querySelectorAll('h1, h2, h3, h4, h5, h6');
  for (const h of Array.from(headings)) {
    // Same slugify rule broken-ref.ts uses to resolve a #heading link's
    // existence (Req 20 US-20.9) — shared so the two never drift apart.
    if (slugifyHeadingText(h.textContent ?? '') === decoded) {
      h.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
      return;
    }
  }
}

/**
 * US-20.5: anchors inside the rendered `## References` section — the run of
 * sibling blocks from the References `<h2>` up to the next H1/H2. Returned as a
 * Set so a clicked anchor can be classified as a References entry AND so the
 * first-body-occurrence search can SKIP them (a broken entry must never
 * navigate to itself).
 */
function referencesSectionAnchors(): Set<HTMLAnchorElement> {
  const anchors = new Set<HTMLAnchorElement>();
  const h2 = Array.from(content.children).find(
    (child) => child.tagName === 'H2' && /^references$/i.test((child.textContent ?? '').trim())
  );
  if (!h2) {
    return anchors;
  }
  for (let sib = h2.nextElementSibling; sib; sib = sib.nextElementSibling) {
    if (sib.tagName === 'H1' || sib.tagName === 'H2') {
      break;
    }
    for (const a of Array.from(sib.querySelectorAll('a[href]'))) {
      anchors.add(a as HTMLAnchorElement);
    }
  }
  return anchors;
}

/**
 * US-20.5: handle a plain click on a References-section entry. A broken (`⚠️`)
 * entry scrolls to + flashes the FIRST body occurrence of the same link and
 * opens the quick-correct fix surface there (the entry itself is only a
 * listing — the real fix is in the body); a healthy entry opens its target
 * file via the normal open flow (no line-jump). Resolves US-20.5's open
 * question for both cases.
 */
function navigateReferenceEntry(anchor: HTMLAnchorElement): void {
  const li = anchor.closest('li');
  const broken = (li?.textContent ?? '').trimStart().startsWith('⚠️');
  if (!broken) {
    openLink(anchor.getAttribute('href') ?? '');
    return;
  }
  const key = normalizeHrefKey(anchor.getAttribute('href') ?? '');
  const sectionAnchors = referencesSectionAnchors();
  const bodyAnchor = (Array.from(content.querySelectorAll('a[href]')) as HTMLAnchorElement[]).find(
    (a) => !sectionAnchors.has(a) && normalizeHrefKey(a.getAttribute('href') ?? '') === key
  );
  if (!bodyAnchor) {
    return;
  }
  bodyAnchor.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  bodyAnchor.classList.add('ref-nav-flash');
  setTimeout(() => bodyAnchor.classList.remove('ref-nav-flash'), 1200);
  quickCorrect.open(bodyAnchor);
}

// ---------------------------------------------------------------------------
// Phím tắt định dạng
// ---------------------------------------------------------------------------

/**
 * US-19.7 (keyboard nav): nhảy giữa các heading bằng phím — Alt+Shift+↓ tới
 * heading kế, Alt+Shift+↑ về heading trước. Chọn combo Alt+Shift+Arrow để
 * không đè điều hướng theo từ/khối sẵn có của contentEditable. Neo theo caret
 * nếu nằm trong #content, ngược lại theo mép trên khung nhìn.
 */
function jumpHeading(dir: 1 | -1): void {
  const headings = Array.from(content.querySelectorAll('h1, h2, h3, h4, h5, h6')) as HTMLElement[];
  if (headings.length === 0) {
    return;
  }
  const sel = window.getSelection();
  const anchor = sel?.anchorNode ? closestElement(sel.anchorNode) : null;
  const currentHeading = anchor?.closest('h1, h2, h3, h4, h5, h6') as HTMLElement | null;
  let idx: number;
  if (currentHeading && content.contains(currentHeading)) {
    idx = headings.indexOf(currentHeading) + dir;
  } else {
    // Không có caret trong heading → chọn theo vị trí cuộn (mép trên khung nhìn).
    const guard = (document.getElementById('toolbar')?.offsetHeight ?? 0) + 8;
    if (dir === 1) {
      idx = headings.findIndex((h) => h.getBoundingClientRect().top > guard + 1);
    } else {
      idx = -1;
      for (let i = headings.length - 1; i >= 0; i--) {
        if (headings[i].getBoundingClientRect().top < guard - 1) {
          idx = i;
          break;
        }
      }
    }
  }
  if (idx < 0 || idx >= headings.length) {
    return;
  }
  const target = headings[idx];
  target.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  const range = document.createRange();
  range.selectNodeContents(target);
  range.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(range);
}

content.addEventListener('keydown', (e) => {
  // Req 20 US-20.2: while a trigger overlay owns the keyboard, the editor's
  // shortcut/undo/redo/arrow handling must not fire — the overlay handles the key.
  if (hasInputOwner()) {
    return;
  }
  const mod = e.metaKey || e.ctrlKey;
  // US-19.7: Alt+Shift+↑/↓ nhảy giữa heading (không cần Ctrl/Cmd).
  if (e.altKey && e.shiftKey && !mod && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    jumpHeading(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (mod && !e.shiftKey && !e.altKey) {
    switch (e.key.toLowerCase()) {
      case 's':
        // Flush thay đổi đang chờ debounce trước khi VS Code lưu file
        flushPendingSync();
        return; // không preventDefault — để VS Code xử lý save
      // Uỷ quyền undo/redo cho TextDocument (một undo stack duy nhất) thay vì
      // history của contentEditable. preventDefault để browser KHÔNG chạy undo
      // native. Gắn kèm pendingText (nếu còn thay đổi chờ debounce) để host
      // commit lần gõ mới nhất thành undo-unit TRƯỚC khi undo.
      case 'z':
        e.preventDefault();
        postToHost({ type: 'undo', pendingText: takePendingSync() });
        return;
      case 'y':
        e.preventDefault();
        postToHost({ type: 'redo', pendingText: takePendingSync() });
        return;
      case 'b':
        applyInlineFormat(e, () => document.execCommand('bold'));
        return;
      case 'i':
        applyInlineFormat(e, () => document.execCommand('italic'));
        return;
      case 'e':
        applyInlineFormat(e, toggleInlineCode);
        return;
      case 'v':
        e.preventDefault();
        pasteFromClipboardApi();
        return;
      case 'x':
        // Chỉ chặn mặc định khi thực sự có vùng chọn để cắt; nếu không, để trình
        // duyệt xử lý bình thường (con trỏ rỗng — không có gì để cắt).
        if (cutSelectionViaClipboardApi()) {
          e.preventDefault();
        }
        return;
    }
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'x') {
    applyInlineFormat(e, () => document.execCommand('strikeThrough'));
    return;
  }
  // Ctrl/Cmd+Shift+Z = redo (quy ước Mac, song song với Ctrl+Y ở trên).
  if (mod && e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    postToHost({ type: 'redo', pendingText: takePendingSync() });
    return;
  }
  // Lưới an toàn giữa phiên: nếu block cuối là khối "bẫy caret" (Mermaid/code/
  // bảng/công thức...) mà <p> thoát đã bị xóa hoặc chưa có, ArrowDown sẽ không
  // đi đâu được. Tạo lại <p> cuối rồi để trình duyệt tự đưa caret vào (KHÔNG
  // preventDefault). Nếu đã có <p> cuối thì đây là no-op. renderDocument lo ca
  // lúc mở file; đây lo ca DOM đổi trong lúc gõ (không re-render).
  if (e.key === 'ArrowDown' && !mod && !e.shiftKey && !e.altKey) {
    ensureTrailingParagraph();
  }
  // Tab trong list → thụt/bỏ thụt lề (tạo phân cấp). Trong ô bảng, chỉ thụt lề
  // khi caret ở ĐẦU mục (quy ước Notion/Docs) để không mất chức năng nhảy ô;
  // ngoài bảng thì Tab trong list luôn thụt lề như trước.
  if (e.key === 'Tab') {
    const sel = window.getSelection();
    const anchor = sel?.anchorNode ? closestElement(sel.anchorNode) : null;
    const li = anchor?.closest('li');
    const cell = anchor?.closest('td, th');
    const cellInside = cell && content.contains(cell);
    if (li && content.contains(li) && (!cellInside || caretAtStartOfListItem(li, sel))) {
      e.preventDefault();
      // Outdent/indent: wired to the compute-then-commit primitive (HLR 22 Phase
      // 2.1/2.2) for their characterized cases (collapsed caret; nested <li> for
      // outdent, <li> with a previous sibling for indent). computeOutdent/
      // computeIndent return null for anything else (top-level <li>, first <li>),
      // and a non-collapsed selection is never attempted -- both fall back to the
      // legacy execCommand unchanged.
      const outdentPlan = e.shiftKey && sel?.isCollapsed ? computeOutdent(li) : null;
      const indentPlan = !e.shiftKey && sel?.isCollapsed ? computeIndent(li) : null;
      if (outdentPlan) {
        commitListOpDirect(outdentPlan, dom.placeCaretAtOffsets);
      } else if (indentPlan) {
        commitListOpDirect(indentPlan, dom.placeCaretAtOffsets);
      } else {
        document.execCommand(e.shiftKey ? 'outdent' : 'indent');
      }
      // Bug #1: indent/outdent vừa dời <li> — dựng lại drag/hover handle đang trỏ
      // vào node cũ (handle là position:fixed, chỉ tính lại toạ độ khi chuột di),
      // mirror đúng renderDocument ở trên.
      dragDrop.refresh();
      warnIfComplexTableList();
      scheduleSync();
      return;
    }
    if (cellInside) {
      e.preventDefault();
      navigateCells(cell as HTMLTableCellElement, e.shiftKey ? -1 : 1);
      return;
    }
    // Bug_General #9: inside a heading, Tab/Shift+Tab demotes/promotes the heading
    // level and applies the SAME delta to every descendant heading in its section
    // (up to, not including, the next same-or-higher heading). Placed AFTER the
    // li/cell branches so list indent and table-cell nav keep priority. Gate on a
    // TOP-LEVEL heading only: a heading nested in a blockquote is not in
    // content.children, so computeHeadingSectionSpan would index-of miss, scan from
    // doc start, and corrupt unrelated headings (mirror drag-drop.ts's includes guard).
    const heading = anchor?.closest('h1,h2,h3,h4,h5,h6') as HTMLElement | null;
    if (heading && heading.parentElement === content) {
      e.preventDefault();
      const delta = e.shiftKey ? -1 : 1;
      const level = headingLevel(heading)!; // 1..6
      // Promote H1: cannot go higher → no-op (including descendant headings).
      if (delta < 0 && level === 1) {
        return;
      }
      // Capture the caret offsets on the ORIGINAL heading before re-tagging; block
      // text is unchanged so offsets map 1-1 into the new element, restored after the
      // whole section is retagged (each replaceBlockTag moves the caret transiently;
      // the final placeCaretAtOffsets overrides it).
      const r = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      const startOff = r ? getOffsetWithin(heading, r.startContainer, r.startOffset) : null;
      const endOff = r
        ? sel!.isCollapsed
          ? startOff
          : getOffsetWithin(heading, r.endContainer, r.endOffset)
        : null;
      const section = computeHeadingSectionSpan(heading, Array.from(content.children) as HTMLElement[]);
      let target: HTMLElement = heading;
      for (const block of section) {
        const lvl = headingLevel(block);
        if (lvl === null) {
          continue; // non-heading content in the section keeps its tag
        }
        const next = lvl + delta;
        // Demote past H6 → normal paragraph; otherwise clamp into 1..6.
        const el = dom.replaceBlockTag(block, next > 6 ? 'p' : `h${Math.max(1, next)}`);
        if (block === heading) {
          target = el;
        }
      }
      if (startOff !== null && endOff !== null) {
        dom.placeCaretAtOffsets(target, startOff, endOff);
      } else {
        dom.placeCaretIn(target);
      }
      dragDrop.refresh();
      scheduleSync();
      return;
    }
  }
});

// ---------------------------------------------------------------------------
// Lưu vị trí scroll vào webview state (giữ khi tab ẩn/hiện)
// ---------------------------------------------------------------------------

let scrollSaveTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener('scroll', saveScrollSoon);

function saveScrollSoon(): void {
  if (scrollSaveTimer !== undefined) {
    clearTimeout(scrollSaveTimer);
  }
  scrollSaveTimer = setTimeout(() => {
    // merge: đừng xoá tocWidth (do toc.ts ghi) khi chỉ cập nhật scrollTop.
    vscode.setState({ ...vscode.getState(), scrollTop: window.scrollY });
  }, SCROLL_SAVE_DEBOUNCE_MS);
}

function restoreScroll(): void {
  const state = vscode.getState();
  if (state?.scrollTop) {
    window.scrollTo({ top: state.scrollTop });
  }
}
