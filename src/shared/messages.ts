/**
 * C3: Hợp đồng type dùng chung cho kênh postMessage giữa extension host
 * (src/provider.ts, bundle Node) và webview (media/webview, bundle browser).
 *
 * Đây là NGUỒN SỰ THẬT DUY NHẤT về hình dạng message hai chiều. Cả hai đầu
 * `import type` từ file này (chỉ là type, esbuild xoá hết lúc bundle nên không
 * kéo code Node vào bundle browser và ngược lại). Đổi tên/field một đầu mà quên
 * đầu kia → compiler báo lỗi thay vì lệch âm thầm.
 */

/** Một gợi ý file trả về cho popup chèn link (kết quả searchWorkspaceFiles). */
export interface FileSuggestion {
  path: string;
  name: string;
  dir: string;
}

/** Phạm vi tìm xuyên file (setting `orcaEditor.crossFileSearch.scope`). */
export type CrossFileSearchScope = 'markdown' | 'allFiles';

/**
 * Reading Mode (US-19.24) — MỘT khái niệm duy nhất thay cho 2 trục preset×palette
 * cũ (US-19.18/19.21/4.27, đã supersede). Mỗi mode tự gói cả typography lẫn màu:
 * - `standard` = follow VS Code theme (reading off/neutral), không rò màu.
 * - `sepia` = typography đọc + màu sepia ấm low-blue.
 * - `paper` = typography đọc + nền kem trắng ấm #fffff8 kiểu ai-2027.com.
 */
export type ReadingMode = 'standard' | 'sepia' | 'paper';

/**
 * Trạng thái Reading Mode (US-19.1/19.6/19.9/19.24). Host dùng để gửi giá trị
 * seed ban đầu (đọc từ `orcaEditor.readability.*` + global override nếu có,
 * xem `resolveReadability`) trong 'init'. `enabled`/`mode` giờ global-in-memory
 * ở host (bug 0716 #2, đảo ngược per-tab cũ của bug 0715 mục 4) — đổi ở 1 tab
 * lan sang mọi tab .md đang mở qua message `readingModeChanged`, cùng mô hình
 * `zen` (US-19.19, kênh `zenChanged`) nhưng độc lập. `fontFamily` KHÔNG nằm
 * trong bundle global này — vẫn chỉ seed 1 lần từ config, không persist ngược.
 * Không đụng nội dung `.md`.
 */
export interface ReadabilityConfig {
  enabled: boolean;
  mode: ReadingMode;
  fontFamily: string;
  zen: boolean;
}

/** Một match tìm thấy trong 1 file, kèm snippet ngữ cảnh ~1 dòng trước/sau. */
export interface CrossFileMatch {
  /** Dòng chứa match (0-based), dùng để mở file đúng vị trí. */
  line: number;
  /** Offset ký tự bắt đầu match trên dòng đó (0-based, UTF-16 code unit). */
  character: number;
  /** Độ dài đoạn khớp (= độ dài query). */
  length: number;
  /** Dòng liền trước, đã trim (rỗng nếu là dòng đầu file). */
  contextBefore: string;
  /** Toàn bộ dòng chứa match, đã trim — webview tự highlight đoạn [character, character+length). */
  lineText: string;
  /** Dòng liền sau, đã trim (rỗng nếu là dòng cuối file). */
  contextAfter: string;
  /** Offset ký tự XẤP XỈ của match trong toàn bộ nội dung file gốc (0-based) — dùng cho positionBoost khi xếp hạng (US-15.7), không dùng để mở file (đã có line/character). */
  charOffset: number;
}

/** Kết quả nhóm theo file cho tìm xuyên file. */
export interface CrossFileMatchGroup {
  /** uri.toString() của file — gửi lại nguyên văn khi bấm mở kết quả. */
  uri: string;
  /** Tên file (basename), hiển thị trong header nhóm. */
  fileName: string;
  /** Đường dẫn tương đối so với workspace, hiển thị dưới tên file. */
  relativePath: string;
  /** Tổng số match THẬT tìm được trong file (trước khi cắt còn tối đa 10 để gửi đi) — dùng cho badge + dòng "+N match khác". */
  totalInFile: number;
  /** Độ dài nội dung file gốc (số ký tự) — mẫu số cho positionBoost khi xếp hạng (US-15.7). */
  fileLength: number;
  matches: CrossFileMatch[];
}

/**
 * Cấu hình render gửi kèm message `init`. Field & kiểu lấy đúng từ
 * provider.ts (case 'ready' → postMessage 'init').
 */
export interface InitConfig {
  breaks: boolean;
  linkify: boolean;
  wordWrap: boolean;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  autoOpenToc: boolean;
  showLineNumbers: boolean;
  /** Giá trị mặc định ban đầu của dropdown scope trong popover tìm xuyên file. */
  crossFileSearchScope: CrossFileSearchScope;
  /** Trạng thái Reading Mode ban đầu (US-19.x). */
  readability: ReadabilityConfig;
  /** Req 20 US-20.2/20.3: seed for the `/` Define+Execute trigger popup. */
  trigger: TriggerConfig;
}

/**
 * Req 20 US-20.2/20.3 seed for the `/` trigger popup.
 *  - `dateFormat`: `orcaEditor.trigger.dateFormat` setting (default `YYYY-MM-DD`),
 *    resolved deterministically by the webview at insert time (US-20.2).
 *  - `executeCommands`: the group-3 Execute command membership list (US-20.3) —
 *    read by the host from the dedicated `contributes.orcaEditorExecuteCommands`
 *    manifest array (ids) + `contributes.commands` (titles → labels), so adding/
 *    removing an id there needs no second edit in webview code.
 */
export interface TriggerConfig {
  dateFormat: string;
  executeCommands: TriggerExecuteCommand[];
  /** Req 21 US-21.5: `orcaEditor.triggerActions.mode` — gates visibility of entity-related trigger actions only. */
  mode: TriggerMode;
}

/**
 * Req 21 US-21.5 (`orcaEditor.triggerActions.mode`) — `simple` hides entity-
 * related trigger actions (the `@` Entities scope, `/declare`, `/relate`);
 * `advanced` (default) shows them. Gates VISIBILITY only — never restyles or
 * hides already-written content (US-21.5).
 */
export type TriggerMode = 'simple' | 'advanced';

/** One Execute-group command row (Req 20 US-20.3) — id must be on the host's membership list. */
export interface TriggerExecuteCommand {
  id: string;
  label: string;
}

/**
 * A caret/selection position shared by `init.reveal` and `scrollToPosition`:
 * 0-based `line`/`character`; `length` = length of the range to select
 * (0/undefined = scroll only, no selection). (`crossFileSearch:openResult`
 * carries the same fields plus a `uri` and a required `matchText`, so it stays
 * declared inline.)
 */
export interface RevealPosition {
  line: number;
  character: number;
  length: number;
  matchText?: string;
}

/**
 * Result of a host-side asset save — shared by `pasteImageResult` and
 * `dropFileResult`. `relativePath` is absent on failure, when `error` carries
 * the toast text instead.
 */
export interface AssetSaveResult {
  requestId: number;
  relativePath?: string;
  error?: string;
}

/**
 * Req 20 US-20.9 / Req 21 US-21.3: one entry of a broken-reference file/heading
 * existence check — `target` echoes back the exact raw string the webview sent
 * (the file part of an href, no `#fragment`) so the webview can map the result
 * back to the anchor(s) that share that target.
 */
export interface TargetExistsResult {
  target: string;
  exists: boolean;
}

/**
 * Req 21 US-21.3: one entity-reference existence check result — mirrors
 * `TargetExistsResult`. `id` echoes back the exact full entity token the webview
 * sent (namespace+id, e.g. `UC01`). `exists` is true ONLY when the id is present
 * in the index AND a live `fs.stat` of its declaration file succeeds (index
 * freshness is NOT existence truth — a stale row whose file was deleted/renamed
 * reports `false`). `occurrences` = how many times that id was seen across the
 * session occurrence cache (current file + any other file opened this session);
 * best-effort, undercounts files not yet opened — never persisted, dies with the
 * session. Sourced only from the cache, never a workspace crawl.
 */
export interface EntityExistResult {
  id: string;
  exists: boolean;
  occurrences: number;
}

/**
 * Req 21 US-21.2: one entity suggestion returned to the popup (result of an
 * `entitySearch`). Same shape as the host-side `IndexedEntity` row: `file` =
 * declaring file's uri.toString(), `line` = 0-based line of its `caption::`
 * declaration, `title` = nearest enclosing heading ('' if none).
 */
export interface EntitySuggestion {
  namespace: string;
  id: string;
  file: string;
  line: number;
  title: string;
}

/** Req 21 US-21.2: one namespace + its entity count for the browse/summary view. */
export interface NamespaceSummary {
  name: string;
  count: number;
}

/** Zen/Focus-mode change — same shape in both directions (webview↔host). */
export type ZenChangedMessage = { type: 'zenChanged'; zen: boolean };

/** Reading-mode change — same shape in both directions (webview↔host). */
export type ReadingModeChangedMessage = {
  type: 'readingModeChanged';
  enabled: boolean;
  mode: ReadingMode;
};

/** Message webview → host (discriminated theo `type`). */
export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'edit'; text: string }
  /**
   * Uỷ quyền undo/redo cho TextDocument (một undo stack duy nhất, đúng mô hình
   * CustomTextEditor): webview chặn Ctrl/Cmd+Z·Y rồi gửi message này, host gọi
   * `executeCommand('undo'|'redo')` → thay đổi document quay lại webview qua
   * 'update'. `pendingText`: nếu còn thay đổi đang chờ debounce lúc bấm phím,
   * webview serialize NGAY và gắn kèm để host commit nó thành 1 undo-unit TRƯỚC
   * khi undo (atomic trong một handler — tránh đua thứ tự với edit debounce).
   */
  | { type: 'undo'; pendingText?: string }
  | { type: 'redo'; pendingText?: string }
  | { type: 'openLink'; href: string }
  | { type: 'searchFiles'; query: string; requestId: number }
  | { type: 'copyFileMention' }
  | { type: 'viewSource' }
  | { type: 'crossFileSearch:request'; requestId: number; query: string; scope: CrossFileSearchScope; matchCase: boolean; wholeWord: boolean }
  | { type: 'crossFileSearch:openResult'; uri: string; line: number; character: number; length: number; matchText: string }
  /** relativePath: có khi bấm "+N match khác trong file này" (GĐ4) — Search panel chỉ hiện kết quả đúng file đó thay vì toàn scope. */
  | { type: 'crossFileSearch:openInSearchPanel'; query: string; scope: CrossFileSearchScope; relativePath?: string }
  /** Ảnh dán từ clipboard (paste event hoặc fallback Clipboard API) — host lưu file thật rồi trả lại đường dẫn tương đối. */
  | { type: 'pasteImage'; requestId: number; mime: string; dataBase64: string }
  /**
   * US-17.6 (M4): file kéo thả từ ngoài (Explorer/Finder) không phải ảnh —
   * host copy vào folder assets (resolveAssetsDir) rồi trả đường dẫn tương
   * đối; webview chèn `[name](path)` tại vị trí thả. Ảnh kéo thả dùng lại
   * message `pasteImage` sẵn có (external-drop.ts gọi thẳng vào luồng
   * paste-image.ts), KHÔNG qua message này.
   */
  | { type: 'dropFile'; requestId: number; name: string; dataBase64: string }
  /**
   * US-19.19: Zen/Focus mode vừa đổi ở TAB NÀY — host giữ lại làm state
   * global-in-memory (KHÔNG persist Settings) rồi phát cho MỌI panel .md
   * khác đang mở (trừ chính panel gửi, đã tự apply cục bộ rồi). Kênh riêng,
   * độc lập với `readingModeChanged` (enabled/mode).
   */
  | ZenChangedMessage
  /**
   * Bug 0716 #2 (reversal 2026-07-16): enabled/mode vừa đổi Ở CHÍNH
   * TAB NÀY — host giữ lại làm state global-in-memory (KHÔNG persist Settings,
   * cùng mô hình như zenChanged) rồi phát cho MỌI panel .md khác đang mở.
   * fontFamily KHÔNG nằm trong bundle này — không có UI toggle runtime, vẫn
   * chỉ seed 1 lần từ setting `orcaEditor.readability.fontFamily`.
   */
  | ReadingModeChangedMessage
  /**
   * Req 20 US-20.3: the `/` popup's Execute group selected `commandId` — the
   * webview never touches the VS Code API directly, so it asks the host to run
   * `vscode.commands.executeCommand(commandId)`. `docUri` is the owning
   * document's uri (`document.uri.toString()`) — the host runs the command only
   * if that document is still the target (a message arriving after a tab switch
   * must never execute against the wrong document). The host validates
   * `commandId` against the same membership list sent in `InitConfig.trigger.
   * executeCommands` — this message is not an arbitrary-command execution surface.
   */
  | { type: 'executeCommand'; commandId: string; docUri: string }
  /**
   * Req 20 US-20.9: broken-reference detection (file/heading links only) —
   * `targets` is the DEDUPED list of raw file-part strings (the `href` up to
   * `#`, never included for a pure `#heading` same-document anchor — those
   * resolve locally against the TOC heading index, no host round trip).
   * `docVersion` is a monotonic counter `broken-ref.ts` bumps every recompute
   * pass, stamped on the response so a late result from a since-superseded
   * scan (the document re-rendered before the host replied) is discarded —
   * same position-validity spirit as `trigger-popup.ts`. Never sent for
   * `http(s)`/other absolute-scheme hrefs.
   */
  | { type: 'checkTargetsExist'; requestId: number; docVersion: number; targets: string[] }
  /**
   * Req 21 US-21.3: broken-ENTITY-reference detection — parallel to
   * `checkTargetsExist` but keyed by full entity token (namespace+id) rather
   * than a file path. `ids` is the DEDUPED list of the `#fragment`s of anchors
   * carrying `ENTITY_REF_CLASS` (an entity reference's display text equals its
   * href fragment, a valid entity token). `docVersion`/`requestId` stamp the
   * same staleness guard as `checkTargetsExist` so a late reply from a
   * superseded scan is discarded.
   */
  | { type: 'checkEntitiesExist'; requestId: number; docVersion: number; ids: string[] }
  /**
   * Req 20 US-20.5: the `/add reference` palette item was picked — the host
   * builds/updates the `## References` section as one ordinary document edit.
   * `docUri` (echoes `InitConfig.docUri`) is verified host-side like
   * `executeCommand` so a message arriving after a tab switch never edits the
   * wrong document. No host→webview reply: the "no new references" outcome is a
   * host `showInformationMessage` toast, not a message shape.
   */
  | { type: 'addReference'; docUri: string }
  /**
   * Req 21 US-21.2: the `@`/`/` entity popup asks the host to search the
   * workspace entity index. `namespace` (optional) narrows to one namespace
   * (case-insensitive). `requestId` echoes back on `entityResult`, mirroring
   * the `searchFiles` -> `fileSearchResult` pattern.
   */
  | { type: 'entitySearch'; requestId: number; query: string; namespace?: string }
  /** Req 21 US-21.2: the popup asks for the namespace browse list (with counts). */
  | { type: 'namespaceList'; requestId: number };

/** Message host → webview (discriminated theo `type`). */
export type HostToWebview =
  | {
      type: 'init';
      text: string;
      /** Req 20 US-20.3: `document.uri.toString()` — echoed back on `executeCommand` so the host can verify this document is still the target. */
      docUri: string;
      config: InitConfig;
      /**
       * C6: vị trí cần scroll tới ngay sau khi render lần đầu — trạng thái
       * "dùng một lần" cho riêng lượt mở panel này (khác `InitConfig`, vốn là
       * setting bền vững). Có khi panel mới mở được điều hướng từ kết quả
       * tìm xuyên file. `line`/`character` 0-based, cùng quy ước với
       * `CrossFileMatch` ở trên. `length` = độ dài đoạn cần select luôn (không
       * chỉ scroll tới) — 0/undefined nếu chỉ cần scroll, không select.
       */
      reveal?: RevealPosition;
    }
  /**
   * `caretLine`/`caretCol` (1-based dòng, 0-based cột, tuỳ chọn): chỉ gửi khi
   * update phát sinh từ undo/redo — webview đặt lại caret về đúng vị trí vừa đổi
   * sau khi render lại (renderDocument dựng lại toàn bộ DOM nên caret mất). Với
   * block đơn dòng (đoạn văn/heading) caret về đúng cột; block đa dòng lùi về đầu
   * block. Update từ external edit (git/formatter/tab khác) không kèm field này →
   * giữ nguyên hành vi cũ (không đụng caret).
   */
  | { type: 'update'; text: string; caretLine?: number; caretCol?: number }
  | { type: 'fileSearchResult'; requestId: number; files: FileSuggestion[] }
  | { type: 'configUpdate'; autoOpenToc: boolean; showLineNumbers: boolean; triggerMode: TriggerMode }
  /**
   * C4: `usedFallback` = true khi host đã âm thầm hạ một truy vấn Whole Word 0
   * kết quả xuống substring cho chính response này — webview hiện thông báo +
   * đồng bộ toggle Whole Word về OFF.
   */
  | { type: 'crossFileSearch:result'; requestId: number; groups: CrossFileMatchGroup[]; truncated: boolean; usedFallback: boolean }
  /** C6b: file .md đã mở sẵn ở tab khác — gửi thẳng tới panel đó thay vì qua 'init'. Cùng ý nghĩa `length` như `reveal` ở trên. */
  | ({ type: 'scrollToPosition' } & RevealPosition)
  /** Kết quả lưu ảnh dán từ clipboard — relativePath thiếu khi lưu thất bại (kèm error để hiện toast). */
  | ({ type: 'pasteImageResult' } & AssetSaveResult)
  /** Kết quả lưu file kéo thả (US-17.6, M4) — cùng hình dạng với pasteImageResult. */
  | ({ type: 'dropFileResult' } & AssetSaveResult)
  /** US-19.19: broadcast lại Zen mới (do 1 tab KHÁC vừa đổi) — webview chỉ apply cục bộ, không gửi ngược lại (tránh vòng lặp). */
  | ZenChangedMessage
  /** Bug 0716 #2: broadcast lại Reading Mode mới (do 1 tab KHÁC vừa đổi) — webview chỉ apply cục bộ, không gửi ngược lại (tránh vòng lặp). */
  | ReadingModeChangedMessage
  /**
   * Req 20 US-20.3: the host, after validating and running
   * `vscode.commands.executeCommand(commandId)` for one of the curated Execute
   * commands, tells THIS webview to run its own existing local action —
   * `readability.toggle()` / `readability.toggleZen()` / `toc.toggle()` — the
   * same functions the toolbar buttons already call (no parallel
   * implementation); reading/zen keep reporting back via `readingModeChanged`/
   * `zenChanged` exactly as when driven from the toolbar.
   */
  | { type: 'runCommand'; command: 'toggleReadingMode' | 'toggleZen' | 'openToc' }
  /** Req 20 US-20.9: reply to `checkTargetsExist`, same `requestId`/`docVersion` echoed back for the staleness check described there. */
  | { type: 'targetsExistResult'; requestId: number; docVersion: number; results: TargetExistsResult[] }
  /** Req 21 US-21.3: reply to `checkEntitiesExist`, same `requestId`/`docVersion` echoed back for the staleness check described there. */
  | { type: 'entitiesExistResult'; requestId: number; docVersion: number; results: EntityExistResult[] }
  /**
   * Req 21 US-21.2: reply to `entitySearch`. `ready` carries the indexing state
   * — when false the initial background build is still running, so the popup
   * shows "indexing…" instead of reading an empty `entities` as "nothing
   * exists" (index freshness is NOT existence truth).
   */
  | { type: 'entityResult'; requestId: number; ready: boolean; entities: EntitySuggestion[] }
  /** Req 21 US-21.2: reply to `namespaceList`; `ready` as in `entityResult`. */
  | { type: 'namespaceListResult'; requestId: number; ready: boolean; namespaces: NamespaceSummary[] };
