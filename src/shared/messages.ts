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
  /**
   * X-12: whether the host filesystem is case-insensitive (Windows, macOS).
   * Threaded so `normalizeHrefKey` folds the path body identically host-side
   * (References dedup) and webview-side (ref-nav body match).
   */
  caseInsensitiveFs: boolean;
  /** Giá trị mặc định ban đầu của dropdown scope trong popover tìm xuyên file. */
  crossFileSearchScope: CrossFileSearchScope;
  /**
   * US-19.25: trạng thái Fit-mode bảng ban đầu (global in-session như Zen). Bật
   * → cột co/wrap vừa panel thay vì scroll ngang. Bake từ `globalTableFitMode`
   * của provider để tab mới trong phiên kế thừa; KHÔNG persist Settings.
   */
  tableFitMode: boolean;
  /** Trạng thái Reading Mode ban đầu (US-19.x). */
  readability: ReadabilityConfig;
  /** Req 20 US-20.2/20.3: seed for the `/` Define+Execute trigger popup. */
  trigger: TriggerConfig;
  /**
   * Req 23 US-23.1: the name that will be recorded as the author on a comment
   * created from this panel (`orcaEditor.comments.authorName`, or the OS
   * username when unset). Shown in the composer so the Reviewer sees which
   * identity is about to be attached; the host resolves it again at create time
   * — this copy is display only, never the value written to the thread.
   */
  commentAuthorName: string;
  /**
   * Req 24 US-23.12 AC4: workspace-relative path (`vscode.workspace.asRelativePath`,
   * forward slashes) for the exported Markdown's `## Review — <path> ...`
   * header. Seeded once at `init` like the rest of this config — the export
   * builds synchronously webview-side (AC2), so it cannot round-trip to the
   * host for this mid-build.
   */
  docRelativePath: string;
  /**
   * Req 23 US-23.2: the "Show Comments" toolbar toggle's persisted state for
   * THIS file, read from `context.workspaceState` (keyed by docUri) — the
   * first user of `workspaceState` in this codebase. Defaults to off until the
   * Author first turns it on for this file (gutter pins always show regardless
   * of this flag; only the inline anchor-range highlight is gated by it).
   */
  commentHighlightOn: boolean;
  /**
   * US-2.8: webview URI of the lazily-loaded PlantUML engine bundle
   * (`dist/webview/plantuml-engine.js`). Resolved host-side because the webview
   * cannot call `asWebviewUri` itself.
   */
  plantumlEngineUri: string;
  /**
   * US-2.8: the page's CSP nonce. Needed so the webview can inject the engine
   * `<script>` at runtime — `script-src` accepts nonced scripts only.
   */
  scriptNonce: string;
  /**
   * P-1 (Performance — Audit.md): webview URI of the lazily-loaded Mermaid
   * engine bundle (`dist/webview/mermaid-engine.js`), same rationale and
   * loading contract as `plantumlEngineUri` — resolved host-side because the
   * webview cannot call `asWebviewUri` itself; reuses `scriptNonce` above.
   */
  mermaidEngineUri: string;
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
  /**
   * Bug General #1: when set, reveal by TEXT SEARCH over the opened document
   * (find this string, scroll to + flash the first match) instead of by
   * `line`/`character`. Used for entity links (`searchText = "caption::NS_ID"`)
   * so navigation works even when the target file is outside the workspace /
   * not in the entity index, and is immune to source-line↔DOM mapping drift.
   * When present, `line`/`character`/`length` are ignored.
   */
  searchText?: string;
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
  /**
   * Req 21 hover tooltip: short preview of the text following the `caption::NS_ID`
   * declaration token (from the entity index). Present for a resolved id so a
   * cross-file mention's tooltip can name what the code refers to; absent/empty
   * when the id is unknown or nothing follows the declaration.
   */
  preview?: string;
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
  /** Req 21: FULL following text (the entity's human name) — a mention inserts it as the link display text so the pill reads `NS_ID label`; '' when nothing follows. */
  label: string;
}

/** Req 21 US-21.2: one namespace + its entity count for the browse/summary view. */
export interface NamespaceSummary {
  name: string;
  count: number;
}

/**
 * Req 23 US-23.3's Open/Resolved/Closed axis, needed here (not just in
 * `sidecar-format.ts`) because `CommentSyncThread` below crosses the wire.
 * Structurally identical to `sidecar-format.ts`'s own `CommentStatus` — kept as
 * a separate literal union deliberately, so this shared wire-format module has
 * no import into a host-only file (per this file's own single-source-of-truth
 * role).
 */
export type CommentStatus = 'Open' | 'Resolved' | 'Closed';

/**
 * Req 23 US-23.3: which transition a `changeCommentStatus` asks for. Named by
 * the ACTION rather than by the target status because the two are not
 * interchangeable — the legal source status and the acting role differ per
 * action (Resolve: Open, Author; Close: Resolved, Reviewer; Reopen:
 * Resolved-or-Closed, Reviewer), so a bare `toStatus: 'Open'` could not tell a
 * Reopen from a fresh thread.
 */
export type CommentStatusAction = 'resolve' | 'close' | 'reopen';

/**
 * Req 23 US-23.11 AC2: one applied status transition, as carried in a
 * `commentThreadsSync` snapshot. `toStatus` alone identifies the move — the
 * source status is whatever the previous entry in the list left behind, and the
 * loader has already dropped any line whose recorded origin disagreed with it.
 */
export interface CommentTransition {
  toStatus: CommentStatus;
  author: string;
  timestamp: string;
}

/** Req 23 US-23.2: one reply, as carried in a `commentThreadsSync` snapshot. */
export interface CommentSyncReply {
  /** Durable sidecar id — what a later `deleteComment.targetReplyId`/`editComment.targetReplyId` names to act on just this reply. */
  id: string;
  author: string;
  timestamp: string;
  body: string;
  /** US-23.14 AC4: the winning `edit` line's timestamp, when this reply has been edited at least once. */
  editedAt?: string;
}

/**
 * Req 23 US-23.2: one thread's full state, pushed on load and after every
 * mutation — the bridge that lets the webview pin/highlight/reply to a thread
 * it did not itself create this session (one that was persisted by a previous
 * session, or created/replied-to from the native `vscode.comments` UI).
 */
export interface CommentSyncThread {
  /**
   * The key the webview must echo back in `replyToComment`/`deleteComment` —
   * mirrors the host's own registry key: a webview-minted threadId for a
   * thread created this session, the durable sidecar comment id for one
   * loaded from disk.
   */
  threadId: string;
  status: CommentStatus;
  author: string;
  timestamp: string;
  body: string;
  /** US-23.14 AC4: the winning `edit` line's timestamp, when the thread's opening comment has been edited at least once. */
  editedAt?: string;
  /** US-23.4 tier 2 snapshot — recorded at creation, only used to seed a thread the webview has not resolved itself yet. */
  recordedText: string;
  /** Character offsets WITHIN `recordedText` — the anchor's own quote, and what places it precisely inside whatever node tier 2 matches it to. */
  offsetStart: number;
  offsetEnd: number;
  lastKnownLine: number;
  nearestHeading: string;
  replies: CommentSyncReply[];
  /**
   * US-23.11 AC2: every applied Resolved/Closed/Reopen transition, oldest first.
   * Carried on the snapshot rather than derived webview-side because the webview
   * never sees the `status-change` lines — and it has to survive a reload, not
   * just the session that performed the transition. Empty while the thread has
   * never left Open.
   *
   * The popover lists the whole trail; the Comment tab row shows only the last
   * entry (design handoff), so no separate last-transition pair is carried.
   */
  statusChanges: CommentTransition[];
}

/**
 * Req 23/24 US-23.9/US-23.16: a sidecar line whose `parent_comment_id`/`target_id`
 * names no known `comment` (or, for `delete`/`edit`, no known `comment` or
 * `reply` either) — merge-orphaned content the fold cannot place. Carried so
 * the Comment tab can list it read-only, instead of it being held invisibly in
 * host memory (US-23.5 AC4 only logged the count).
 */
export interface CommentSyncOrphan {
  id: string;
  kind: 'reply' | 'status-change' | 'anchor-update' | 'delete' | 'edit';
  author: string;
  timestamp: string;
  /** The reply/edit body, the status recorded, the anchor-update origin, or the delete's target id. */
  detail: string;
}

/**
 * Req 23 US-23.9: what the host knows about the sidecar behind a snapshot, so
 * an empty list can say WHY it is empty. Absent fields mean "nothing to report".
 */
export interface CommentSidecarState {
  /**
   * The sidecar read for this document has not settled yet. The `ready` handler
   * posts a snapshot the moment a webview registers, which is normally BEFORE
   * the disk read finishes — without this flag an empty `threads` array plus an
   * absent report is indistinguishable from "loaded, and the file has none".
   */
  loading?: boolean;
  /**
   * US-23.5's content-based belonging check said none of the recorded texts are
   * in this document — a reused path or an out-of-VS-Code rename. One banner,
   * rather than N unexplained "Unresolved location" rows.
   */
  foreign?: boolean;
  /** Why this document can hold no comments, or why its sidecar could not be read. */
  problem?: string;
  orphans?: CommentSyncOrphan[];
  /**
   * US-23.15 AC3: how many sidecar lines the load discarded — unparseable,
   * unrecognised, a duplicate id the fold dropped, or an illegal status jump it
   * skipped. Absent when nothing was lost. A count, not the lines themselves:
   * the point is "your list is incomplete", and the Output channel already
   * carries each line's own reason.
   */
  skipped?: number;
  /** US-23.15 AC4: the sidecar holds git conflict markers — it is mid-merge, not merely damaged. */
  conflicted?: boolean;
}

/** Zen/Focus-mode change — same shape in both directions (webview↔host). */
export type ZenChangedMessage = { type: 'zenChanged'; zen: boolean };

/** US-19.25: table Fit-mode change — same shape both directions (webview↔host). */
export type TableFitModeChangedMessage = { type: 'tableFitModeChanged'; on: boolean };

/** Reading-mode change — same shape in both directions (webview↔host). */
export type ReadingModeChangedMessage = {
  type: 'readingModeChanged';
  enabled: boolean;
  mode: ReadingMode;
};

/** Message webview → host (discriminated theo `type`). */
export type WebviewToHost =
  | { type: 'ready' }
  /**
   * Performance Audit P-8: steady-state typing sends only the CHANGED REGION of
   * the document, not the whole text. Two variants, discriminated by whether
   * `text` is present; both carry `baseRev`, and the host applies both by
   * arriving at ONE full text and running it through the same
   * `applyMinimalEdit`/undo-coalescing path as before P-8 — the wire payload
   * shrinks, nothing downstream changes.
   *
   * The host mirrors what it believes the webview's `currentText` to be, and
   * the diff is only sound against an exact mirror, so `baseRev` names the
   * frame of reference: it is the `rev` of the last host push the webview
   * ACTUALLY adopted (see `HostToWebview`'s 'update'). A push the webview
   * deferred instead of adopting (a trigger popup owning the keyboard — see
   * `pendingUpdate` in main.ts) leaves the two sides on different revs, which is
   * exactly the case a length check alone cannot see. On `baseRev` ≠ the mirror's
   * rev — or a failed `baseLength`/bounds check, which catch a mirror bug rather
   * than a legitimate divergence — the host drops the diff untouched and asks
   * for a resync; no partial application is ever attempted.
   *
   * `baseLength` is the mirror's expected length (the webview's `currentText`
   * length before this edit); `start`/`oldEnd` index that same base text.
   *
   * `seq` is the counter described on the REVERSE direction's diff-shaped
   * 'update' — the webview's own advance count AFTER this edit, so the host can
   * tell whether its mirror has caught up with every text the webview authored.
   */
  | {
      type: 'edit';
      start: number;
      oldEnd: number;
      newText: string;
      baseLength: number;
      baseRev: number;
      seq: number;
    }
  /**
   * The full-text, self-healing variant — every 'edit' had this shape before
   * P-8. Sent in reply to `requestFullSync`, and it re-anchors the host's mirror
   * onto `baseRev` (the rev the WEBVIEW is actually on) and `seq`, so the two
   * sides converge after one round trip instead of resyncing forever.
   */
  | { type: 'edit'; text: string; baseRev: number; seq: number }
  /**
   * Uỷ quyền undo/redo cho TextDocument (một undo stack duy nhất, đúng mô hình
   * CustomTextEditor): webview chặn Ctrl/Cmd+Z·Y rồi gửi message này, host gọi
   * `executeCommand('undo'|'redo')` → thay đổi document quay lại webview qua
   * 'update'. `pendingText`: nếu còn thay đổi đang chờ debounce lúc bấm phím,
   * webview serialize NGAY và gắn kèm để host commit nó thành 1 undo-unit TRƯỚC
   * khi undo (atomic trong một handler — tránh đua thứ tự với edit debounce).
   *
   * `pendingSeq` accompanies `pendingText`: that text is an advance of the
   * webview's `currentText` delivered WITHOUT an 'edit', so the host mirrors it
   * from here — and must mirror its `seq` from here too, or the mirror is right
   * about the text while claiming a stale advance count, and every subsequent
   * host push falls back to full text for no reason.
   */
  | { type: 'undo'; pendingText?: string; pendingSeq?: number }
  | { type: 'redo'; pendingText?: string; pendingSeq?: number }
  /**
   * Performance Audit P-8 (reverse half): a diff-shaped 'update' arrived against
   * a base this webview does not hold (see `baseRev`/`baseSeq` on
   * `HostToWebview`'s 'update') — it was DROPPED, not partially applied. Asks
   * the host to re-push the document in full, which needs no base and therefore
   * always lands. The mirror image of the host's `requestFullSync`.
   */
  | { type: 'requestFullPush' }
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
   * US-19.25: Fit-mode bảng vừa đổi Ở CHÍNH TAB NÀY — host giữ lại làm state
   * global-in-memory (KHÔNG persist Settings, cùng mô hình zenChanged) rồi phát
   * cho MỌI panel .md khác đang mở.
   */
  | TableFitModeChangedMessage
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
  | { type: 'namespaceList'; requestId: number }
  /**
   * Req 23 US-23.1: the "Add Comment" composer was submitted — create a native
   * `vscode.comments` CommentThread for the anchored selection/caret. The
   * STRUCTURAL anchor (`anchorId` + the character offsets WITHIN that node) is
   * authoritative; `line` (1-based source line of the anchored node's block, 0
   * when it maps to none) is a best-effort coordinate only, there so the host
   * can hand the native API the `vscode.Range` it requires. Nothing here edits
   * the `.md` — comments never enter the document's text or undo stack
   * (US-23.6). `docUri` (echoes `InitConfig.docUri`) is verified host-side like
   * `executeCommand`/`addReference` so a message arriving after a tab switch
   * never creates a thread against the wrong document.
   */
  | {
      type: 'createComment';
      requestId: number;
      docUri: string;
      /**
       * Req 23 US-23.4: the webview's handle for this thread. Minted webview-side
       * because that is the side which re-resolves the anchor across edits and so
       * has to name the thread a later `commentAnchorUpdate` refers to.
       */
      threadId: string;
      anchorId: string;
      offsetStart: number;
      offsetEnd: number;
      line: number;
      body: string;
      /** Req 23 US-23.4 tier 2: full text of the anchored node at creation time. */
      recordedText: string;
      /** Req 23 US-23.4 tier 2: heading the anchored node sat under — a tie-breaker, never a match key. */
      nearestHeading: string;
    }
  /**
   * Req 23 US-23.4: a tier relocated (or gave up on) a thread's anchor — move the
   * native `CommentThread`'s best-effort Range to `line` and mark it with the new
   * resolution `state`. Fire-and-forget for an in-memory-only relocation: the
   * structural anchor stays authoritative and the webview has already applied
   * the move, so there is no requestId/reply pair for that case. This path must
   * never edit the `.md` — a comment action never occupies a slot in the
   * document's undo stack (US-23.6).
   *
   * Req 24 US-23.13 AC1/AC2: `origin` is set only when this transition should
   * also be PERSISTED — a deliberate re-attach (`'manual'`) or an automatic
   * promotion out of floating (`'resolved'`). Omitted for every other
   * relocation, which stays in-memory only, unchanged from before this AC. When
   * set, `offsetStart`/`offsetEnd`/`recordedText`/`nearestHeading` (the same
   * fields `createComment` carries) are what the host writes into the new
   * `anchor-update` sidecar line; a failed persist is reported back via
   * `commentAnchorUpdateResult` below, keyed by `threadId` since this message
   * itself carries no `requestId`.
   */
  | {
      type: 'commentAnchorUpdate';
      docUri: string;
      threadId: string;
      anchorId: string;
      line: number;
      state: 'exact' | 'approximate' | 'floating';
      origin?: 'manual' | 'resolved';
      offsetStart: number;
      offsetEnd: number;
      recordedText: string;
      nearestHeading: string;
    }
  /**
   * Req 23 US-23.2: append a reply under an existing thread. `threadId` is
   * whatever key the host registered the thread under — the webview-minted
   * handle for a thread created this session, or the durable sidecar id echoed
   * back by `commentThreadsSync` for one loaded from disk. Rejected (empty/
   * whitespace body, unknown thread, thread Closed) without appending a sidecar
   * line — the host validates since it alone knows live thread status.
   */
  | { type: 'replyToComment'; requestId: number; docUri: string; threadId: string; body: string }
  /**
   * Req 23 US-23.2 PO decision: delete a thread or one reply under it — a
   * confirmation-gated, cascading physical rewrite of the sidecar
   * (`store.removeComment`, Req 24
   * `_bmad-output/quick-dev/inprogress-comment-delete-sidecar-rewrite.md`),
   * not an appended `delete` tombstone. `targetReplyId` absent deletes the
   * WHOLE thread (cascading to every reply); present deletes only that one
   * reply, leaving the thread and its other replies intact. Enforced
   * host-side as a soft, non-authenticated author-match nudge
   * (`orcaEditor.comments.authorName`), same convention as US-23.3's
   * Close-gating.
   */
  | { type: 'deleteComment'; requestId: number; docUri: string; threadId: string; targetReplyId?: string }
  /**
   * US-23.14: correct a comment's or reply's own `body` — never a rewrite of the
   * original `comment`/`reply` line (US-23.5 AC2, US-23.6), always a new `edit`
   * sidecar line append (US-23.5). `targetReplyId` absent edits the thread's
   * opening comment; present edits that one reply. Rejected (empty/whitespace
   * body after trim, over the shared length bound, unknown target, thread
   * Closed) without appending a sidecar line — same host-side validation
   * convention as `deleteComment`/`changeCommentStatus`. No authority check
   * (AC8): any user with the file open may edit any comment or reply.
   */
  | { type: 'editComment'; requestId: number; docUri: string; threadId: string; targetReplyId?: string; body: string }
  /**
   * Req 23 US-23.3: move a thread along the Open → Resolved → Closed axis, or
   * Reopen it back to Open in one step. Appends a `status-change` sidecar line
   * (US-23.5) — never rewrites a prior line, and never edits the `.md`
   * (US-23.6). The host validates the whole request against the thread's live
   * status, which only it knows — and against nothing else: US-23.11 AC1 removed
   * the identity gate, so availability is a function of the status alone.
   */
  | {
      type: 'changeCommentStatus';
      requestId: number;
      docUri: string;
      threadId: string;
      action: CommentStatusAction;
    }
  /**
   * Req 23 US-23.2: the "Show Comments" toolbar toggle changed for THIS file —
   * persisted host-side via `context.workspaceState`, keyed by `docUri`. Purely
   * a per-file UI preference; unlike `zenChanged`/`readingModeChanged` it is
   * NOT broadcast to other panels (a per-file setting, not a global one).
   */
  | { type: 'commentHighlightToggled'; docUri: string; on: boolean }
  /**
   * Req 24 US-23.12: reply to a menu click ("Copy all as Markdown", self-minted
   * `requestId`) or to a `requestCommentsMarkdownExport` (host-minted
   * `requestId` echoed back). `exportable: true` carries the built Markdown for
   * the host to write to the clipboard; `threadCount`/`hiddenClosedCount` feed
   * AC1's confirmation wording. `exportable: false` is the nothing-to-export
   * case, reachable only via the host-initiated round trip — the menu item is
   * disabled instead of sending this variant (AC8).
   */
  | {
      type: 'copyCommentsAsMarkdown';
      requestId: number;
      docUri: string;
      exportable: true;
      markdown: string;
      threadCount: number;
      hiddenClosedCount?: number;
    }
  | { type: 'copyCommentsAsMarkdown'; requestId: number; docUri: string; exportable: false; reason: string };

/** Message host → webview (discriminated theo `type`). */
export type HostToWebview =
  | {
      type: 'init';
      text: string;
      /** Performance Audit P-8: the rev this initial `text` is stamped with — the webview's first `baseRev`. Same counter as 'update' below. */
      rev: number;
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
   *
   * Performance Audit P-8: `rev` is a monotonic counter the host bumps on every
   * push (this message and 'init'). The webview echoes back, as `baseRev`, the
   * rev of the push it last ACTUALLY adopted into `currentText` — a push it
   * deferred or dropped does not count — which is how the host knows whether its
   * mirror of the webview's text still describes the same document.
   */
  | { type: 'update'; text: string; caretLine?: number; caretCol?: number; rev: number }
  /**
   * Performance Audit P-8 (reverse half): the diff-shaped 'update' — the same
   * message, carrying only the CHANGED REGION of the document instead of the
   * whole text. Discriminated from the full-text variant above by whether `text`
   * is present, exactly as `WebviewToHost`'s two 'edit' shapes are. The webview
   * rebuilds the full text (`rebuildFromEditDiff`) and then runs the UNCHANGED
   * render path, so only the wire payload differs.
   *
   * `start`/`oldEnd` index the base text, `baseLength` is its expected length.
   * A diff is sound only against the exact base it was computed from, and TWO
   * independent counters are needed to prove the webview still holds that base:
   *
   * - `baseRev` — the rev of the push the host's mirror is anchored to. Catches
   *   divergence the HOST caused: a push the webview deferred (a trigger popup
   *   owning the keyboard) or dropped leaves the webview on an older rev.
   * - `baseSeq` — the webview's own advance count (`localSeq`) as last received
   *   by the host. Catches divergence the WEBVIEW caused: an 'edit' still in
   *   flight means the webview's `currentText` has moved on while `baseRev` is
   *   unchanged (a webview-authored advance bumps no rev), so the rev gate is
   *   blind to it. `baseLength` alone is not enough either — overtyping a
   *   selection with equal-length text keeps the length and would splice at the
   *   wrong offsets into the user's file.
   *
   * On either counter disagreeing — or a failed `baseLength`/bounds check — the
   * webview drops the diff untouched and posts `requestFullPush`; no partial
   * application is ever attempted. `rev` is this push's own rev either way.
   */
  | {
      type: 'update';
      start: number;
      oldEnd: number;
      newText: string;
      baseLength: number;
      baseRev: number;
      baseSeq: number;
      caretLine?: number;
      caretCol?: number;
      rev: number;
    }
  /**
   * Performance Audit P-8: a diff-shaped 'edit' arrived against a base the host
   * does not hold (see `baseRev` on `WebviewToHost`'s 'edit') — it was DROPPED,
   * not partially applied. Resend the current state as a full-text 'edit', which
   * self-heals the document regardless of what diverged.
   */
  | { type: 'requestFullSync' }
  | { type: 'fileSearchResult'; requestId: number; files: FileSuggestion[] }
  /**
   * `orcaEditor.*` changed in Settings. `commentAuthorName` rides along (Req 23
   * US-23.3 AC6): the host re-reads that setting per action, so a webview holding
   * the value it got at `init` would keep gating Resolve/Close/Reopen — and the
   * anchor-lost dialog — on a stale identity, leaving AC6's own documented
   * "edit the setting to get past the nudge" needing a panel reload.
   */
  | {
      type: 'configUpdate';
      autoOpenToc: boolean;
      showLineNumbers: boolean;
      triggerMode: TriggerMode;
      commentAuthorName: string;
    }
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
  /** US-19.25: broadcast lại Fit-mode mới (do 1 tab KHÁC vừa đổi) — webview chỉ apply cục bộ, không gửi ngược lại (tránh vòng lặp). */
  | TableFitModeChangedMessage
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
  | { type: 'runCommand'; command: 'toggleReadingMode' | 'toggleZen' | 'openToc' | 'toggleTableFitMode' }
  /** Req 20 US-20.9: reply to `checkTargetsExist`, same `requestId`/`docVersion` echoed back for the staleness check described there. */
  | { type: 'targetsExistResult'; requestId: number; docVersion: number; results: TargetExistsResult[] }
  /** Req 21 US-21.3: reply to `checkEntitiesExist`, same `requestId`/`docVersion` echoed back for the staleness check described there. */
  | { type: 'entitiesExistResult'; requestId: number; docVersion: number; results: EntityExistResult[] }
  /**
   * P1 follow-up: the entity index just absorbed a (debounced) reindex or a
   * file-delete drop. Broadcast to every open panel so broken-ref markers
   * re-check against the fresh index — the webview's own edit echo is
   * suppressed, so without this push a marker computed against the pre-reindex
   * index would persist until the next mutation.
   */
  | { type: 'entityIndexUpdated' }
  /**
   * Req 21 US-21.2: reply to `entitySearch`. `ready` carries the indexing state
   * — when false the initial background build is still running, so the popup
   * shows "indexing…" instead of reading an empty `entities` as "nothing
   * exists" (index freshness is NOT existence truth).
   */
  | { type: 'entityResult'; requestId: number; ready: boolean; entities: EntitySuggestion[] }
  /** Req 21 US-21.2: reply to `namespaceList`; `ready` as in `entityResult`. */
  | { type: 'namespaceListResult'; requestId: number; ready: boolean; namespaces: NamespaceSummary[] }
  /**
   * Req 23 US-23.1: reply to `createComment`. `ok: false` carries the reason in
   * `error` (a stale/rejected request must surface to the Reviewer, never fail
   * silently and never leave a thread against an empty anchor); the webview
   * clears its in-flight guard on either outcome so a rejected attempt can be
   * retried.
   */
  | {
      type: 'createCommentResult';
      requestId: number;
      ok: boolean;
      error?: string;
      /**
       * Req 23 US-23.4: the author actually recorded on the thread and when.
       * Present only on success. The host re-reads `orcaEditor.comments.authorName`
       * (falling back to the OS username) at create time, so this is the only
       * accurate source — `InitConfig.commentAuthorName` is a display hint the
       * user may have changed since. The webview needs both to render a floating
       * thread's card in the "Unresolved location" panel.
       */
      author?: string;
      timestamp?: string;
    }
  /**
   * Req 23 US-23.2: full per-document thread snapshot, pushed once the webview
   * has a document loaded (right after the sidecar load resolves) and again
   * after every create/reply/delete/anchor-update. `docUri` guards a message
   * that arrives after a tab switch, same convention as `init`.
   */
  | {
      type: 'commentThreadsSync';
      docUri: string;
      threads: CommentSyncThread[];
      /** US-23.9: the sidecar's own health, so an empty list can name its cause. */
      sidecar?: CommentSidecarState;
    }
  /**
   * Req 23 US-23.2: reply to `replyToComment`. `ok: false` carries the reason in
   * `error` (empty body, unknown thread, thread Closed); on success `replyId`/
   * `author`/`timestamp` are what a later `deleteComment.targetReplyId` and the
   * popover's own-authorship check need — the host mints the reply's durable id
   * and re-resolves the author setting, so the webview's own guess must not be
   * trusted for either.
   */
  | { type: 'replyResult'; requestId: number; ok: boolean; error?: string; replyId?: string; author?: string; timestamp?: string }
  /** Req 23 US-23.2: reply to `deleteComment`. `ok: false` carries the refusal reason (unknown target, author mismatch). */
  | { type: 'deleteCommentResult'; requestId: number; ok: boolean; error?: string }
  /**
   * US-23.14: reply to `editComment`. `ok: false` carries the refusal reason
   * (empty body, over the length bound, unknown target, thread Closed,
   * deleted-while-editing). `ok: true` carries nothing else on purpose — the new
   * body and `editedAt` reach every surface through the `commentThreadsSync`
   * push that follows, same rationale as `changeCommentStatusResult`.
   */
  | { type: 'editCommentResult'; requestId: number; ok: boolean; error?: string }
  /**
   * Req 23 US-23.3: reply to `changeCommentStatus`. `ok: false` carries the
   * refusal reason: an illegal transition from the thread's live status, or a
   * transition already in flight for it (US-23.11 AC7). `ok: true` carries
   * nothing else on purpose — the new
   * status, actor and timestamp all reach every surface through the
   * `commentThreadsSync` push that follows, so echoing them here would be a
   * second source of truth for the same three values.
   */
  | { type: 'changeCommentStatusResult'; requestId: number; ok: boolean; error?: string }
  /**
   * Req 24 US-23.13 AC1/AC2: reply to a `commentAnchorUpdate` that carried an
   * `origin` (a persist-worthy transition). Keyed by `threadId`, not
   * `requestId` — the request itself has none. Only a failure needs surfacing:
   * a successful persist has already been applied in the webview's own
   * registry, so there is nothing left to reconcile.
   */
  | { type: 'commentAnchorUpdateResult'; docUri: string; threadId: string; ok: boolean; error?: string }
  /**
   * Req 24 US-23.12: the `orcaEditor.copyCommentsAsMarkdown` command asks this
   * panel — the one resolved as the active document's Orca editor — to build
   * its current export using this panel's own live sort/"Hide closed" state,
   * and reply with `copyCommentsAsMarkdown` under the same `requestId`.
   */
  | { type: 'requestCommentsMarkdownExport'; requestId: number }
  /**
   * Req 24 US-23.12: reply to `copyCommentsAsMarkdown`. `ok: false` carries the
   * clipboard-write rejection reason (AC1); `ok: true` carries nothing else —
   * the confirmation/`showInformationMessage` was already shown host-side.
   */
  | { type: 'copyCommentsAsMarkdownResult'; requestId: number; ok: boolean; error?: string };
