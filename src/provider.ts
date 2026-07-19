import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  CrossFileMatch,
  CrossFileMatchGroup,
  CrossFileSearchScope,
  HostToWebview,
  ReadabilityConfig,
  ReadingPalette,
  ReadingPreset,
  WebviewToHost,
} from './shared/messages';
import {
  classifyLink,
  computeMinimalEdit,
  imageNamePrefix,
  normalizeForSearch,
  relativePath,
  sanitizeDroppedFileName,
} from './text-utils';
import { findTextMatches, type MatchOptions } from './shared/text-match';
import { rankFileGroups } from './shared/rank-utils';

/** Chờ tối đa bao lâu cho edit của undo/redo thực sự áp vào document trước khi coi là no-op. */
const UNDO_SETTLE_MS = 200;

/**
 * Promise resolve khi `document` đổi lần kế tiếp, hoặc sau `timeoutMs` nếu không
 * có (trường hợp không còn gì để undo/redo). executeCommand('undo') có thể resolve
 * TRƯỚC khi edit áp vào document, nên phải chờ sự kiện thật thay vì đọc getText()
 * ngay sau await.
 */
function waitForDocChange(document: vscode.TextDocument, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    function done(): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      sub.dispose();
      resolve();
    }
    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        done();
      }
    });
    const timer = setTimeout(done, timeoutMs);
  });
}

/** Vị trí nguồn (dòng 1-based, cột 0-based) của offset ký tự `offset` trong `text`. */
function sourceLineCol(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, col: end - lineStart };
}

/**
 * Custom text editor: hiển thị markdown dạng WYSIWYG (render giống VS Code
 * Markdown Preview) và đồng bộ hai chiều với TextDocument.
 *
 * Đồng bộ:
 *  - Webview gửi {type:'edit', text} (toàn bộ markdown đã serialize) sau khi
 *    người dùng gõ (debounce phía webview). Extension áp dụng minimal edit
 *    (diff prefix/suffix) để giữ undo/scroll của text editor ổn định.
 *  - Document đổi từ nơi khác (text editor, git, format...) → gửi
 *    {type:'update', text} cho webview render lại. Echo từ chính webview được
 *    chặn bằng cách so sánh với văn bản cuối cùng webview gửi lên.
 */
export class MarkdownWysiwygProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'orcaEditor.editor';

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      MarkdownWysiwygProvider.viewType,
      new MarkdownWysiwygProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      }
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * C6b: registry panel đang mở theo uri.toString(). `supportsMultipleEditorsPerDocument:
   * true` (xem register() ở trên) cho phép NHIỀU panel Orca Editor cùng mở 1
   * document cùng lúc — vì vậy giá trị là 1 Set, không phải 1 panel duy nhất.
   * Dùng để: khi kết quả tìm xuyên file trỏ tới 1 file .md đã có panel mở sẵn,
   * gửi thẳng 'scrollToPosition' tới panel đó thay vì mở lại (vscode.openWith).
   */
  private panelsByUri = new Map<string, Set<vscode.WebviewPanel>>();

  /**
   * US-19.19: Zen/Focus mode giờ là trạng thái GLOBAL (khác enabled/preset/
   * palette — vẫn per-tab, US-19.18) — bật/tắt ở 1 tab lan sang MỌI tab .md
   * đang mở. `undefined` = chưa tab nào đổi trong phiên này → seed tab mới
   * theo `orcaEditor.readability.zen` như cũ. Chỉ sống trong bộ nhớ process
   * (KHÔNG ghi persist Settings — Zen là "phiên tập trung" tạm thời, không
   * nên tự động bật lại mỗi khi mở lại VS Code); tắt/mở lại VS Code thì về
   * đúng default trong settings.json.
   */
  private globalZen: boolean | undefined;

  /**
   * Bug 0716 #2 (reversal 2026-07-16): cùng mô hình `globalZen` ở trên nhưng
   * cho bundle enabled/preset/palette — trước đó (bug 0715 mục 4, US-19.17–
   * 19.20) 3 field này cố tình per-tab, session-only; user giờ đổi ý muốn
   * global giống hệt Zen. `undefined` = chưa tab nào đổi trong phiên này →
   * seed tab mới theo `orcaEditor.readability.*` như cũ. `fontFamily` KHÔNG
   * nằm trong bundle này — không có UI toggle runtime nên vẫn seed theo
   * setting mỗi tab, không đổi.
   */
  private globalReadingMode: { enabled: boolean; preset: ReadingPreset; palette: ReadingPalette } | undefined;

  /**
   * C6a: vị trí "chờ áp dụng" cho 1 uri — set trước khi gọi vscode.openWith
   * (panel .md CHƯA tồn tại), đọc + xoá đúng 1 lần khi resolveCustomTextEditor
   * gửi message 'init' cho document đó. Dùng một lần: nếu không xoá ngay, mở
   * lại file này sau đó (không qua cross-file-search) sẽ vô tình áp lại vị trí
   * cũ.
   */
  private pendingReveal = new Map<string, { line: number; character: number; length: number; matchText?: string }>();

  /**
   * US-19.19: đọc ReadabilityConfig từ settings.json rồi ghi đè `zen` bằng
   * `globalZen` (nếu đã có tab nào đổi trong phiên này) — dùng ở CẢ bake HTML
   * lúc first paint LẪN message 'init', để tab mới mở luôn khớp trạng thái
   * Zen hiện tại của mọi tab khác thay vì lúc nào cũng đọc lại default tĩnh.
   */
  private resolveReadability(cfg: vscode.WorkspaceConfiguration): ReadabilityConfig {
    const readability = readReadabilityConfig(cfg);
    return {
      ...readability,
      ...(this.globalZen === undefined ? {} : { zen: this.globalZen }),
      ...(this.globalReadingMode ?? {}),
    };
  }

  /**
   * US-19.19: gửi Zen mới cho MỌI panel .md đang mở (mọi uri), trừ panel vừa
   * tự đổi (đã apply cục bộ rồi, gửi lại sẽ là round-trip thừa vô hại nhưng
   * không cần thiết).
   */
  private broadcastZen(zen: boolean, exclude: vscode.WebviewPanel): void {
    this.broadcastToOtherPanels(exclude, { type: 'zenChanged', zen });
  }

  /** Bug 0716 #2: cùng cơ chế broadcastZen ở trên, cho bundle enabled/preset/palette. */
  private broadcastReadingMode(
    state: { enabled: boolean; preset: ReadingPreset; palette: ReadingPalette },
    exclude: vscode.WebviewPanel
  ): void {
    this.broadcastToOtherPanels(exclude, { type: 'readingModeChanged', ...state });
  }

  /** Post `message` to every open .md panel (all uris) except `exclude`. */
  private broadcastToOtherPanels(exclude: vscode.WebviewPanel, message: HostToWebview): void {
    for (const panels of this.panelsByUri.values()) {
      for (const panel of panels) {
        if (panel !== exclude) {
          void panel.webview.postMessage(message);
        }
      }
    }
  }

  /** Kênh log dùng chung — tạo một lần, dùng cho các lỗi bị nuốt ở catch rộng. */
  private static outputChannel: vscode.OutputChannel | undefined;
  private static log(message: string, err?: unknown): void {
    if (!MarkdownWysiwygProvider.outputChannel) {
      MarkdownWysiwygProvider.outputChannel = vscode.window.createOutputChannel('Markdown WYSIWYG');
    }
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : err !== undefined ? String(err) : '';
    MarkdownWysiwygProvider.outputChannel.appendLine(
      `[${new Date().toISOString()}] ${message}${detail ? ` — ${detail}` : ''}`
    );
  }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const webview = webviewPanel.webview;
    const documentDir = vscode.Uri.joinPath(document.uri, '..');
    const docUriStr = document.uri.toString();

    // C6b: đăng ký panel này vào registry theo uri, để openCrossFileSearchResult
    // có thể tìm lại và nhắm 'scrollToPosition' đúng panel khi file .md đã mở sẵn.
    // Bug 0716 #1: lookup-or-create + add() đều dời vào case 'ready' bên dưới
    // (không làm ở đây) — panel lúc này chưa có webview.html, chưa có message
    // listener sống, 1 broadcast 'zenChanged' rơi vào khoảng này sẽ bị rớt.
    // Gộp cả lookup-or-create vào lúc 'ready' luôn (không tách làm 2 nơi) để
    // tránh giữ 1 tham chiếu Set có thể đã bị 1 panel anh em (cùng uri) dispose
    // xong xoá khỏi panelsByUri trong lúc panel này vẫn đang chờ 'ready'.

    /** Gửi message tới webview theo đúng hợp đồng HostToWebview (C3). */
    const postToWebview = (msg: HostToWebview): Thenable<boolean> => webview.postMessage(msg);

    // S6: thu hẹp phạm vi tài nguyên cục bộ — chỉ cho phép dist của extension,
    // thư mục chứa document, và (nếu có) workspace folder chứa chính document.
    // Không trải toàn bộ workspaceFolders để không lộ các folder dự án khác.
    const localResourceRoots = [
      vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
      documentDir,
    ];
    const documentFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (documentFolder) {
      localResourceRoots.push(documentFolder.uri);
    }

    webview.options = { enableScripts: true, localResourceRoots };
    // Bug 0715 (US-19.9): bake sẵn trạng thái đọc vào HTML để first paint đã
    // đúng — mở tab khi Zen bật thì toolbar phải ẩn NGAY từ đầu, không hiện ra
    // rồi trượt lên (animation trượt chỉ dành cho user bấm nút Focus). Zen
    // dùng resolveReadability (US-19.19: global) để tab mới mở khớp Zen hiện
    // tại của các tab khác, không chỉ default tĩnh trong settings.json.
    const initialReadability = this.resolveReadability(
      vscode.workspace.getConfiguration('orcaEditor', document.uri)
    );
    webview.html = this.getHtml(webview, documentDir, initialReadability);

    /** Văn bản cuối cùng mà webview đẩy lên qua 'edit' — dùng để chặn echo. */
    let lastTextFromWebview: string | undefined;
    /** Serializes webview-originated document mutations — see case 'edit'. */
    let editChain: Promise<void> = Promise.resolve();
    /**
     * Trạng thái document NGAY TRƯỚC edit webview liền trước. Nếu edit hiện tại đưa
     * document về đúng chuỗi này → nó là nghịch đảo chính xác của edit trước (vd
     * paste ảnh rồi xoá ngay). VS Code gộp cặp insert↔delete nghịch đảo thành MỘT
     * undo-element net-zero (trạng thái giữa — có ảnh — không undo tới được). Tách
     * để phá coalescing (xem applyEditBreakingCoalesce).
     */
    let prevEditBeforeText: string | undefined;

    // P-01: debounce các thay đổi document dồn dập (git checkout, format, gõ ở
    // text editor bên ngoài) để gộp thành một lần postMessage 'update'.
    const UPDATE_DEBOUNCE_MS = 120;
    let updateTimer: ReturnType<typeof setTimeout> | undefined;
    // Bật trong lúc xử lý undo/redo do webview yêu cầu: changeSubscription bỏ qua
    // đường 'update' debounce cho các thay đổi này, để case 'undo'/'redo' tự gửi
    // MỘT update cuối cùng (không debounce) → undo↔redo render đối xứng.
    let undoRedoInProgress = false;

    const changeSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      if (e.contentChanges.length === 0) {
        return;
      }
      const text = e.document.getText();
      // C5: chạy TRƯỚC echo-check bên dưới — undo trong webview (Ctrl+Z trên
      // contentEditable) đi qua đúng flow 'edit' bình thường (xem
      // restoreUndoneImageDeletions), nên e.document.getText() === lastTextFromWebview
      // và sẽ bị early-return nếu đặt sau.
      void this.restoreUndoneImageDeletions(e.document, text);
      // Undo/redo tự lo gửi update cuối cùng (case bên dưới) — không đi debounce.
      if (undoRedoInProgress) {
        return;
      }
      if (text === lastTextFromWebview) {
        // Thay đổi này do chính webview tạo ra — webview đã ở đúng trạng thái.
        return;
      }
      lastTextFromWebview = undefined;
      if (updateTimer !== undefined) {
        clearTimeout(updateTimer);
      }
      updateTimer = setTimeout(() => {
        updateTimer = undefined;
        void postToWebview({ type: 'update', text: document.getText() });
      }, UPDATE_DEBOUNCE_MS);
    });

    // C4: dọn ảnh dán bị mồ côi (paste nhầm rồi undo...) mỗi lần file được
    // lưu — xem cleanupOrphanImages để biết phạm vi và giới hạn.
    const saveSubscription = vscode.workspace.onDidSaveTextDocument((saved) => {
      if (saved.uri.toString() !== document.uri.toString()) {
        return;
      }
      void this.cleanupOrphanImages(saved);
    });

    // Áp dụng ngay autoOpenToc/showLineNumbers khi người dùng đổi setting, không
    // cần đóng/mở lại preview.
    const configSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('orcaEditor', document.uri)) {
        return;
      }
      const wysiwygCfg = vscode.workspace.getConfiguration('orcaEditor', document.uri);
      // KHÔNG gửi enabled/preset/palette/zen qua configUpdate: dù cả 2 bundle
      // giờ đều global-in-memory (zen: US-19.19; enabled/preset/palette: bug
      // 0716 #2, đảo ngược per-tab cũ của bug 0715 mục 4), mỗi bundle đã có
      // kênh broadcast runtime riêng của chính nó (xem case 'zenChanged' /
      // case 'readingModeChanged'). Kênh configUpdate này CHỈ phát khi user
      // đổi orcaEditor.* trong Settings — chỉ seed 1 lần lúc 'init', không
      // liên quan 2 kênh runtime kia.
      void postToWebview({
        type: 'configUpdate',
        autoOpenToc: wysiwygCfg.get<boolean>('autoOpenToc', true),
        showLineNumbers: wysiwygCfg.get<boolean>('showLineNumbers', true),
      });
    });

    const messageSubscription = webview.onDidReceiveMessage(async (msg: WebviewToHost) => {
      switch (msg.type) {
        case 'ready': {
          // Bug 0716 #1: panel chỉ được đăng ký vào panelsByUri (và do đó lộ
          // diện cho broadcastZen/openCrossFileSearchResult) từ đây. Lookup-or-
          // create lại tại chỗ thay vì tái dùng biến bắt ở đầu hàm — Set cũ có
          // thể đã bị 1 panel anh em (cùng uri) dispose xong xoá khỏi
          // panelsByUri trong lúc panel này còn đang tải/chờ 'ready'.
          let panelsForUri = this.panelsByUri.get(docUriStr);
          if (!panelsForUri) {
            panelsForUri = new Set();
            this.panelsByUri.set(docUriStr, panelsForUri);
          }
          panelsForUri.add(webviewPanel);
          const cfg = vscode.workspace.getConfiguration('markdown.preview', document.uri);
          const editorCfg = vscode.workspace.getConfiguration('editor', document.uri);
          const wysiwygCfg = vscode.workspace.getConfiguration('orcaEditor', document.uri);
          // C6a: vị trí chờ áp dụng (nếu panel này vừa được mở từ 1 kết quả
          // tìm xuyên file) — dùng một lần, xoá ngay khỏi map để không áp lại
          // cho lần mở file sau đó không qua cross-file-search.
          const reveal = this.pendingReveal.get(docUriStr);
          if (reveal) {
            this.pendingReveal.delete(docUriStr);
          }
          void postToWebview({
            type: 'init',
            text: document.getText(),
            ...(reveal ? { reveal } : {}),
            config: {
              breaks: cfg.get<boolean>('breaks', false),
              linkify: cfg.get<boolean>('linkify', true),
              wordWrap: editorCfg.get<string>('wordWrap', 'off') !== 'off',
              fontSize: cfg.get<number>('fontSize', 14),
              lineHeight: cfg.get<number>('lineHeight', 1.6),
              fontFamily: cfg.get<string>(
                'fontFamily',
                '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, "Ubuntu", "Droid Sans", sans-serif'
              ),
              autoOpenToc: wysiwygCfg.get<boolean>('autoOpenToc', true),
              showLineNumbers: wysiwygCfg.get<boolean>('showLineNumbers', true),
              crossFileSearchScope: wysiwygCfg.get<CrossFileSearchScope>('crossFileSearch.scope', 'markdown'),
              readability: this.resolveReadability(wysiwygCfg),
            },
          });
          break;
        }
        case 'edit': {
          const text = msg.text;
          // Chain, don't apply directly: the webview can post two 'edit's in
          // the SAME frame (invokeAction: flush of pending typing + the
          // action's own sync — two deliberate undo units, bug 0717), and
          // onDidReceiveMessage does not await async handlers. Unchained, the
          // second applyMinimalEdit would diff against a document the first
          // edit hasn't committed to yet — a mis-anchored replace corrupting
          // the text. lastTextFromWebview is set INSIDE the thunk so each
          // edit's echo suppression is armed exactly while ITS change applies.
          editChain = editChain.then(async () => {
            const beforeThis = document.getText();
            // Nghịch đảo chính xác của edit trước → phá coalescing để undo dừng được
            // ở trạng thái giữa (xem prevEditBeforeText).
            const isInverseOfPrev =
              prevEditBeforeText !== undefined && text === prevEditBeforeText && text !== beforeThis;
            lastTextFromWebview = text;
            const ok = isInverseOfPrev
              ? await this.applyEditBreakingCoalesce(document, text)
              : await this.applyMinimalEdit(document, text);
            if (!ok) {
              lastTextFromWebview = undefined;
            }
            prevEditBeforeText = beforeThis;
          });
          await editChain;
          break;
        }
        case 'undo':
        case 'redo': {
          // Any in-flight chained 'edit' must commit first — its undo unit
          // precedes this undo/redo chronologically (bug 0717).
          await editChain;
          // pendingText: commit lần gõ mới nhất (đang chờ debounce ở webview)
          // thành 1 undo-unit TRƯỚC khi undo — atomic trong handler này.
          if (msg.pendingText !== undefined) {
            lastTextFromWebview = msg.pendingText;
            await this.applyMinimalEdit(document, msg.pendingText);
          }
          const before = document.getText();
          // executeCommand('undo') có thể resolve TRƯỚC khi edit thực sự áp vào
          // document → CHỜ đúng sự kiện đổi rồi mới đọc trạng thái cuối (không
          // đọc getText() ngay sau await, sẽ ra "before" và tưởng là no-op).
          // undoRedoInProgress = true suốt lúc chờ để changeSubscription bỏ qua
          // đường debounce; case này tự gửi MỘT update cuối (bỏ debounce).
          undoRedoInProgress = true;
          try {
            const changed = waitForDocChange(document, UNDO_SETTLE_MS);
            await vscode.commands.executeCommand(msg.type);
            await changed;
            // Nhường 1 nhịp cho các sự kiện đổi con (nếu undo áp nhiều sub-edit) settle.
            await new Promise<void>((r) => setTimeout(r, 0));
          } finally {
            undoRedoInProgress = false;
          }
          const after = document.getText();
          if (after === before) {
            break; // không còn gì để undo/redo
          }
          // Gửi THẲNG trạng thái cuối, bỏ debounce updateTimer: mỗi Ctrl+Z/Y =
          // đúng một lần render nên undo và redo đối xứng (không còn redo "hiện
          // lần lượt từng chữ" do debounce nuốt bước trung gian). Kèm caret
          // (cuối đoạn vừa đổi) để webview đặt lại caret sau khi render.
          if (updateTimer !== undefined) {
            clearTimeout(updateTimer);
            updateTimer = undefined;
          }
          lastTextFromWebview = undefined;
          const diff = computeMinimalEdit(before, after);
          const caret = diff ? sourceLineCol(after, diff.start + diff.newText.length) : undefined;
          void postToWebview({ type: 'update', text: after, caretLine: caret?.line, caretCol: caret?.col });
          break;
        }
        case 'openLink': {
          void this.openLink(document, msg.href);
          break;
        }
        case 'searchFiles': {
          const files = await this.searchWorkspaceFiles(document, msg.query);
          void postToWebview({ type: 'fileSearchResult', requestId: msg.requestId, files });
          break;
        }
        case 'copyFileMention': {
          void this.copyFileMention(document);
          break;
        }
        case 'viewSource': {
          void this.viewSource(document);
          break;
        }
        case 'crossFileSearch:request': {
          const { groups, truncated, usedFallback } = await this.crossFileSearch(document, msg.query, msg.scope, {
            matchCase: msg.matchCase,
            wholeWord: msg.wholeWord,
          });
          void postToWebview({ type: 'crossFileSearch:result', requestId: msg.requestId, groups, truncated, usedFallback });
          break;
        }
        case 'crossFileSearch:openResult': {
          void this.openCrossFileSearchResult(document, msg.uri, msg.line, msg.character, msg.length, msg.matchText);
          break;
        }
        case 'crossFileSearch:openInSearchPanel': {
          void this.openInSearchPanel(msg.query, msg.scope, msg.relativePath);
          break;
        }
        case 'pasteImage': {
          const result = await this.savePastedImage(document, msg.mime, msg.dataBase64);
          void postToWebview({ type: 'pasteImageResult', requestId: msg.requestId, ...result });
          break;
        }
        case 'dropFile': {
          const result = await this.saveDroppedFile(document, msg.name, msg.dataBase64);
          void postToWebview({ type: 'dropFileResult', requestId: msg.requestId, ...result });
          break;
        }
        case 'zenChanged': {
          // US-19.19: Zen giờ global — nhớ trong bộ nhớ process (seed tab mới
          // mở sau đó) rồi phát cho mọi panel .md khác đang mở.
          this.globalZen = msg.zen;
          this.broadcastZen(msg.zen, webviewPanel);
          break;
        }
        case 'readingModeChanged': {
          // Bug 0716 #2: enabled/preset/palette giờ global (đảo ngược per-tab
          // cũ, cùng mô hình zenChanged ở trên) — nhớ trong bộ nhớ process rồi
          // phát cho mọi panel .md khác đang mở.
          // S-1: whitelist preset/palette trước khi lưu — message từ webview có
          // thể bị giả giá trị ngoài enum, mà globalReadingMode được nội suy vào
          // class attribute của getHtml cho panel mở sau (cùng ràng buộc mà
          // readReadabilityConfig áp cho đường settings). Giá trị lạ → mặc định.
          this.globalReadingMode = {
            enabled: msg.enabled,
            preset: READING_PRESETS.includes(msg.preset) ? msg.preset : 'comfortable',
            palette: READING_PALETTES.includes(msg.palette) ? msg.palette : 'followTheme',
          };
          this.broadcastReadingMode(this.globalReadingMode, webviewPanel);
          break;
        }
      }
    });

    webviewPanel.onDidDispose(() => {
      if (updateTimer !== undefined) {
        clearTimeout(updateTimer);
        updateTimer = undefined;
      }
      changeSubscription.dispose();
      saveSubscription.dispose();
      configSubscription.dispose();
      messageSubscription.dispose();

      // C6b: gỡ panel khỏi registry để tránh rò rỉ / nhắm 'scrollToPosition'
      // vào 1 panel đã đóng.
      const panels = this.panelsByUri.get(docUriStr);
      if (panels) {
        panels.delete(webviewPanel);
        if (panels.size === 0) {
          this.panelsByUri.delete(docUriStr);
        }
      }
    });
  }

  /** Áp dụng newText bằng một edit nhỏ nhất (common prefix/suffix diff). */
  private async applyMinimalEdit(document: vscode.TextDocument, newText: string): Promise<boolean> {
    const diff = computeMinimalEdit(document.getText(), newText);
    if (!diff) {
      return true;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(document.positionAt(diff.start), document.positionAt(diff.oldEnd)),
      diff.newText
    );
    return vscode.workspace.applyEdit(edit);
  }

  /** Áp một replace đơn qua applyEdit (helper cho applyEditBreakingCoalesce). */
  private applyRange(document: vscode.TextDocument, start: number, end: number, text: string): Thenable<boolean> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(end)), text);
    return vscode.workspace.applyEdit(edit);
  }

  /**
   * Áp newText bằng HAI applyEdit riêng, tạo một trạng thái GIỮA khác biệt mọi
   * checkpoint đã có → phá việc VS Code gộp cặp edit nghịch đảo thành một
   * undo-element net-zero (vd paste ảnh rồi xoá ngay: trạng thái giữa có ảnh không
   * undo tới được). Kết quả cuối luôn đúng bằng newText. Dùng khi edit là nghịch đảo
   * chính xác của edit liền trước (xem prevEditBeforeText).
   */
  private async applyEditBreakingCoalesce(document: vscode.TextDocument, newText: string): Promise<boolean> {
    const diff = computeMinimalEdit(document.getText(), newText);
    if (!diff) {
      return true;
    }
    const { start, oldEnd, newText: ins } = diff;
    if (ins === '' && oldEnd - start >= 2) {
      // Xoá thuần: tách vùng xoá làm đôi (xoá nửa sau trước, rồi nửa đầu).
      const mid = start + Math.floor((oldEnd - start) / 2);
      if (!(await this.applyRange(document, mid, oldEnd, ''))) {
        return false;
      }
      return this.applyRange(document, start, mid, '');
    }
    if (ins !== '' && oldEnd > start) {
      // Replace: xoá cũ trước, chèn mới sau (trạng thái giữa = đã xoá, chưa chèn).
      if (!(await this.applyRange(document, start, oldEnd, ''))) {
        return false;
      }
      return this.applyRange(document, start, start, ins);
    }
    // Chèn thuần hoặc xoá 1 ký tự: không tách được có ý nghĩa → áp bình thường.
    return this.applyRange(document, start, oldEnd, ins);
  }

  private async openLink(document: vscode.TextDocument, href: string): Promise<void> {
    const link = classifyLink(href);
    if (link.kind === 'empty') {
      return;
    }
    if (link.kind === 'absolute') {
      // URL tuyệt đối: chỉ cho phép allowlist (markdown-it validateLink không
      // áp dụng cho raw HTML anchor nên phải tự chặn ở đây).
      if (!link.safe) {
        void vscode.window.showWarningMessage(`Blocked link with unsafe scheme: ${link.scheme}:`);
        return;
      }
      try {
        await vscode.env.openExternal(vscode.Uri.parse(href, true));
      } catch (err) {
        MarkdownWysiwygProvider.log(`openExternal failed for href: ${href}`, err);
      }
      return;
    }
    // Đường dẫn tương đối so với file hiện tại — không cho thoát ra ngoài
    // thư mục tài liệu / workspace (path traversal qua ../..).
    const [pathPart] = href.split('#');
    if (!pathPart) {
      return;
    }
    const target = vscode.Uri.joinPath(document.uri, '..', decodeURIComponent(pathPart));
    if (!(await this.isInsideAllowedRoots(document, target))) {
      void vscode.window.showWarningMessage(`Blocked link pointing outside the workspace: ${href}`);
      return;
    }
    try {
      await vscode.commands.executeCommand('vscode.open', target);
    } catch (err) {
      MarkdownWysiwygProvider.log(`vscode.open failed for target: ${target.toString()}`, err);
      void vscode.window.showWarningMessage(`Could not open link: ${href}`);
    }
  }

  /**
   * Mở kết quả tìm xuyên file tại đúng vị trí match: file .md mở bằng chính
   * Orca Editor (vscode.openWith + viewType), file khác mở bằng text editor
   * thường (vscode.open) — theo yêu cầu B. "mở file đó (Orca Editor nếu là
   * .md, editor thường nếu không)". Cùng kiểu try/catch + log + cảnh báo như
   * openLink() ở trên để nhất quán trong file.
   *
   * C6: `selection` trong TextDocumentShowOptions chỉ được VS Code tự áp dụng
   * cho text editor chuẩn — với custom editor webview (.md) nó bị bỏ qua âm
   * thầm, nên phải tự forward vị trí qua 2 kênh tuỳ trạng thái panel:
   *  - Panel .md đã mở sẵn (registry `panelsByUri`, có thể do
   *    supportsMultipleEditorsPerDocument) → reveal panel đó rồi gửi thẳng
   *    'scrollToPosition', KHÔNG gọi lại vscode.openWith (sẽ dư thừa/có thể
   *    tạo thêm editor group).
   *  - Chưa có panel nào → set `pendingReveal` rồi mới openWith; panel mới sẽ
   *    đọc lại giá trị này khi gửi message 'init' (xem case 'ready' ở trên).
   */
  private async openCrossFileSearchResult(
    document: vscode.TextDocument,
    uriStr: string,
    line: number,
    character: number,
    length: number,
    matchText?: string
  ): Promise<void> {
    try {
      const uri = vscode.Uri.parse(uriStr);
      // S-2: kết quả tìm thật luôn nằm trong workspace — chặn uri không phải
      // scheme file hoặc trỏ ra ngoài allowed roots (webview có thể bị giả uri
      // để mở file tuỳ ý), cùng guard như đường link tương đối trong openLink().
      if (uri.scheme !== 'file' || !(await this.isInsideAllowedRoots(document, uri))) {
        void vscode.window.showWarningMessage(`Blocked opening a file outside the workspace: ${uriStr}`);
        return;
      }
      const range = new vscode.Range(
        new vscode.Position(line, character),
        new vscode.Position(line, character + length)
      );
      const isMarkdown = /\.(md|markdown)$/i.test(uri.path);
      if (isMarkdown) {
        const existingPanels = this.panelsByUri.get(uri.toString());
        if (existingPanels && existingPanels.size > 0) {
          // Ưu tiên panel đang active (focus) nếu có, không thì lấy đại 1 cái.
          let target: vscode.WebviewPanel | undefined;
          for (const panel of existingPanels) {
            if (panel.active) {
              target = panel;
              break;
            }
          }
          if (!target) {
            target = existingPanels.values().next().value;
          }
          target?.reveal(target.viewColumn);
          const msg: HostToWebview = { type: 'scrollToPosition', line, character, length, matchText };
          void target?.webview.postMessage(msg);
        } else {
          this.pendingReveal.set(uri.toString(), { line, character, length, matchText });
          await vscode.commands.executeCommand('vscode.openWith', uri, MarkdownWysiwygProvider.viewType, {
            selection: range,
          });
        }
      } else {
        await vscode.commands.executeCommand('vscode.open', uri, { selection: range });
      }
    } catch (err) {
      MarkdownWysiwygProvider.log(`crossFileSearch:openResult failed for uri: ${uriStr}`, err);
      void vscode.window.showWarningMessage(`Could not open file: ${uriStr}`);
    }
  }

  /**
   * "Xem thêm trong Search panel" — đẩy query sang panel Search chuẩn của VS Code khi popover
   * không đủ chỗ hiển thị hết.
   *
   * `relativePath` (GĐ4, US-15.6 điểm 3): có khi bấm dòng "+N match khác trong file này" của 1
   * group cụ thể — scope Search panel về ĐÚNG file đó thay vì glob rộng `markdown`/`allFiles`.
   */
  private async openInSearchPanel(query: string, scope: CrossFileSearchScope, relativePath?: string): Promise<void> {
    try {
      await vscode.commands.executeCommand('workbench.action.findInFiles', {
        query,
        filesToInclude: relativePath ?? (scope === 'markdown' ? '*.md,*.markdown' : ''),
        isCaseSensitive: false,
      });
    } catch (err) {
      MarkdownWysiwygProvider.log('crossFileSearch:openInSearchPanel failed', err);
    }
  }

  /** Copies the current file's "@relativePath" mention to the clipboard — works with any chat that understands @file mention syntax. */
  private async copyFileMention(document: vscode.TextDocument): Promise<void> {
    const mention = `@${vscode.workspace.asRelativePath(document.uri, false)}`;
    try {
      await vscode.env.clipboard.writeText(mention);
    } catch (err) {
      MarkdownWysiwygProvider.log('copyFileMention failed', err);
      void vscode.window.showWarningMessage(`Could not copy "${mention}" to the clipboard.`);
      return;
    }
    vscode.window.setStatusBarMessage(`Copied "${mention}"`, 4000);
  }

  /** Mở chính file đang xem ở text editor thường (mã nguồn .md thô) cạnh bên. */
  private async viewSource(document: vscode.TextDocument): Promise<void> {
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false,
      preserveFocus: false,
    });
  }

  /** Thư mục không bao giờ chứa file đáng để link tới từ tài liệu markdown. */
  private static readonly FILE_SEARCH_EXCLUDE =
    '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/coverage/**}';

  private static readonly FILE_SEARCH_MAX_SCAN = 5000;
  private static readonly FILE_SEARCH_MAX_RESULTS = 20;

  // --- Tìm xuyên file (crossFileSearch) — cùng tinh thần với FILE_SEARCH_* ở
  // trên nhưng là tính năng riêng: tìm NỘI DUNG (không phải tên file) trên
  // nhiều file cùng lúc, theo scope 'markdown' | 'allFiles'.
  /** Số file tối đa quét nội dung — glob rộng (đặc biệt allFiles) có thể rất lớn. */
  private static readonly CROSS_FILE_SEARCH_MAX_FILES = 500;
  /** Số file (nhóm) tối đa có mặt trong kết quả — điều kiện dừng CHÍNH khi quét (cap theo số file). */
  private static readonly CROSS_FILE_SEARCH_MAX_GROUPS = 5;
  /** Cap an toàn thuần kỹ thuật khi quét match TRONG 1 file — tránh 1 file cực lớn (hàng chục nghìn match) làm treo regex; tách biệt khỏi cap hiển thị. */
  private static readonly CROSS_FILE_SEARCH_MAX_MATCHES_PER_FILE_SCAN = 500;
  /** Số match tối đa serialize (gửi cho webview) cho MỖI file — phần còn lại lộ qua field `totalInFile` của group đó. */
  private static readonly CROSS_FILE_SEARCH_MAX_MATCHES_PER_FILE_DISPLAY = 10;
  /** scope 'allFiles': loại thêm ảnh/binary phổ biến ngoài các thư mục build/deps. */
  private static readonly CROSS_FILE_SEARCH_EXCLUDE_ALL =
    '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/coverage/**,' +
    '**/*.png,**/*.jpg,**/*.jpeg,**/*.gif,**/*.svg,**/*.ico,**/*.webp,**/*.bmp,' +
    '**/*.pdf,**/*.zip,**/*.gz,**/*.tar,**/*.7z,**/*.rar,' +
    '**/*.woff,**/*.woff2,**/*.ttf,**/*.eot,**/*.otf,' +
    '**/*.mp4,**/*.mp3,**/*.mov,**/*.avi,**/*.wav,' +
    '**/*.exe,**/*.dll,**/*.so,**/*.bin,**/*.class,**/*.jar}';

  // P-08: cache danh sách URI của workspace với TTL ngắn để không glob lại
  // toàn bộ cây thư mục cho mỗi ký tự gõ; chỉ re-score theo query trong bộ nhớ.
  private static readonly FILE_SEARCH_CACHE_TTL_MS = 4000;
  private fileListCache: { uris: readonly vscode.Uri[]; expires: number } | undefined;

  private async getWorkspaceFileList(): Promise<readonly vscode.Uri[]> {
    const now = Date.now();
    if (this.fileListCache && this.fileListCache.expires > now) {
      return this.fileListCache.uris;
    }
    const uris = await vscode.workspace.findFiles(
      '**/*',
      MarkdownWysiwygProvider.FILE_SEARCH_EXCLUDE,
      MarkdownWysiwygProvider.FILE_SEARCH_MAX_SCAN
    );
    this.fileListCache = { uris, expires: now + MarkdownWysiwygProvider.FILE_SEARCH_CACHE_TTL_MS };
    return uris;
  }

  /**
   * Tìm file trong workspace có tên liên quan đến query (text được select khi
   * chèn link). So khớp không phân biệt hoa thường và không phân biệt dấu
   * tiếng Việt ("Đăng ký sự kiện" khớp "dang-ky-su-kien.md").
   *
   * Xếp hạng: khớp nguyên cụm trong tên file > số token khớp trong tên file >
   * số token khớp trong đường dẫn; ưu tiên nhẹ file markdown và tên ngắn hơn.
   */
  private async searchWorkspaceFiles(
    document: vscode.TextDocument,
    rawQuery: string
  ): Promise<Array<{ path: string; name: string; dir: string }>> {
    const tokens = normalizeForSearch(rawQuery)
      .split('-')
      .filter((t) => t.length >= 2);
    if (tokens.length === 0) {
      return [];
    }
    const phrase = tokens.join('-');
    const uris = await this.getWorkspaceFileList();

    const documentDir = vscode.Uri.joinPath(document.uri, '..').path;
    const scored: Array<{ score: number; nameLength: number; uri: vscode.Uri; name: string }> = [];
    for (const uri of uris) {
      if (uri.toString() === document.uri.toString()) {
        continue; // không gợi ý link tới chính file đang mở
      }
      const segments = uri.path.split('/');
      const name = segments[segments.length - 1];
      const baseNorm = normalizeForSearch(name.replace(/\.[^.]*$/, ''));
      const dirNorm = normalizeForSearch(segments.slice(0, -1).join(' '));
      const inBase = tokens.filter((t) => baseNorm.includes(t)).length;
      const inDir = tokens.filter((t) => dirNorm.includes(t)).length;
      if (inBase === 0 && inDir < tokens.length) {
        continue; // phải khớp tên file, hoặc toàn bộ token nằm trong đường dẫn
      }
      let score = inBase * 10 + inDir * 2;
      if (tokens.length > 1 && baseNorm.includes(phrase)) {
        score += 100;
      }
      if (/\.(md|markdown)$/i.test(name)) {
        score += 3;
      }
      scored.push({ score, nameLength: name.length, uri, name });
    }

    scored.sort((a, b) => b.score - a.score || a.nameLength - b.nameLength || (a.name < b.name ? -1 : 1));
    return scored.slice(0, MarkdownWysiwygProvider.FILE_SEARCH_MAX_RESULTS).map((item) => {
      const rel = vscode.workspace.asRelativePath(item.uri, false);
      return {
        path: relativePath(documentDir, item.uri.path),
        name: item.name,
        dir: rel.slice(0, Math.max(0, rel.length - item.name.length - 1)) || '.',
      };
    });
  }

  /**
   * Tìm literal `query` (không phân biệt hoa/thường, không phải regex) trong
   * nội dung nhiều file của workspace — mục B "Tìm xuyên file trong project".
   *
   * - File đang mở trong editor (kể cả đang sửa dở, chưa lưu) được đọc từ
   *   buffer `vscode.workspace.textDocuments` để bắt cả nội dung chưa save;
   *   file khác đọc từ đĩa qua workspace.fs.
   * - File đang mở trong CHÍNH editor này (document) bị loại trừ hoàn toàn.
   * - Giới hạn kết quả theo SỐ FILE là chính: tối đa CROSS_FILE_SEARCH_MAX_GROUPS
   *   file có match được trả về — quét file theo thứ tự findFiles trả về, dừng
   *   thu thập file MỚI ngay khi đã đủ nhóm. Trong MỖI file, số match thật tìm
   *   được KHÔNG bị chặn bởi tổng toàn cục nữa (tránh 1 file nhiều match ăn hết
   *   ngân sách khiến file khác không được quét tới) — chỉ có 1 cap an toàn kỹ
   *   thuật riêng theo file (CROSS_FILE_SEARCH_MAX_MATCHES_PER_FILE_SCAN) để
   *   tránh treo regex ở file cực lớn. Số match SERIALIZE cho webview mỗi file
   *   bị cắt còn tối đa CROSS_FILE_SEARCH_MAX_MATCHES_PER_FILE_DISPLAY; tổng số
   *   thật giữ lại ở field `totalInFile` để webview hiện badge + dòng overflow.
   *   `truncated` = true nếu còn FILE chưa quét (đủ 5 nhóm nhưng còn uri chưa
   *   xét, hoặc chính findFiles đã bị cắt ở CROSS_FILE_SEARCH_MAX_FILES).
   */
  private async crossFileSearch(
    document: vscode.TextDocument,
    query: string,
    scope: CrossFileSearchScope,
    options: MatchOptions
  ): Promise<{ groups: CrossFileMatchGroup[]; truncated: boolean; usedFallback: boolean }> {
    if (!query) {
      return { groups: [], truncated: false, usedFallback: false };
    }

    const include = scope === 'markdown' ? '**/*.{md,markdown}' : '**/*';
    const exclude =
      scope === 'markdown'
        ? MarkdownWysiwygProvider.FILE_SEARCH_EXCLUDE
        : MarkdownWysiwygProvider.CROSS_FILE_SEARCH_EXCLUDE_ALL;
    const uris = await vscode.workspace.findFiles(
      include,
      exclude,
      MarkdownWysiwygProvider.CROSS_FILE_SEARCH_MAX_FILES
    );

    // Một lượt quét theo `opts` — giữ NGUYÊN mọi cap/exclusion/đọc buffer/loại
    // trừ file hiện tại; chỉ thay primitive so khớp (indexOf phẳng → lõi chung
    // findTextMatches, để logic ranh giới từ Unicode-aware khớp hệt webview).
    const scan = async (
      opts: MatchOptions
    ): Promise<{ groups: CrossFileMatchGroup[]; truncated: boolean; total: number }> => {
      const groups: CrossFileMatchGroup[] = [];
      let totalMatches = 0;
      // findFiles tự nó đã có thể bị cắt bớt ở cap quét file — nếu số file trả
      // về đúng bằng cap, coi như "có thể còn file chưa quét".
      let truncated = uris.length >= MarkdownWysiwygProvider.CROSS_FILE_SEARCH_MAX_FILES;

      for (const uri of uris) {
        if (uri.toString() === document.uri.toString()) {
          continue; // loại trừ hoàn toàn file đang mở, không tính vào cap
        }
        if (groups.length >= MarkdownWysiwygProvider.CROSS_FILE_SEARCH_MAX_GROUPS) {
          truncated = true;
          break;
        }

        let text: string;
        try {
          const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
          if (openDoc) {
            text = openDoc.getText();
          } else {
            const bytes = await vscode.workspace.fs.readFile(uri);
            text = new TextDecoder().decode(bytes);
          }
        } catch (err) {
          // Một file lỗi (quyền truy cập, binary lọt qua glob...) không được
          // làm hỏng cả lượt tìm — bỏ qua file đó, log lại rồi tiếp tục.
          MarkdownWysiwygProvider.log(`crossFileSearch: could not read ${uri.toString()}`, err);
          continue;
        }

        const lines = text.split(/\r\n|\r|\n/);
        const fileMatches: CrossFileMatch[] = [];
        let hitFileScanCap = false;
        // Offset xấp xỉ (US-15.7 positionBoost) của đầu dòng hiện tại trong `text`
        // gốc — split() làm mất ký tự xuống dòng thật (\n hay \r\n) nên cộng dồn
        // +1/dòng chỉ là gần đúng, đủ dùng cho tín hiệu xếp hạng (không dùng để
        // định vị mở file — line/character vẫn là nguồn sự thật cho việc đó).
        let lineStartOffset = 0;
        for (let lineNo = 0; lineNo < lines.length && !hitFileScanCap; lineNo++) {
          const rawLine = lines[lineNo];
          // Trim TRƯỚC rồi so khớp trên chuỗi đã trim, để character luôn khớp
          // đúng vị trí trong lineText trả về (bất biến bắt buộc: webview chỉ
          // slice(character, character+length) từ lineText, không tự tìm lại).
          const trimmedLine = rawLine.trim();
          const leadingWhitespace = rawLine.length - rawLine.trimStart().length;
          // Cap an toàn kỹ thuật RIÊNG CHO FILE NÀY — không còn dùng ngân sách
          // toàn cục, để 1 file nhiều match không chặn việc quét file khác.
          const remaining =
            MarkdownWysiwygProvider.CROSS_FILE_SEARCH_MAX_MATCHES_PER_FILE_SCAN - fileMatches.length;
          if (remaining <= 0) {
            hitFileScanCap = true;
            break;
          }
          const offsets = findTextMatches(trimmedLine, query, opts, remaining);
          for (const { start, end } of offsets) {
            fileMatches.push({
              line: lineNo,
              character: start,
              length: end - start,
              contextBefore: lineNo > 0 ? lines[lineNo - 1].trim() : '',
              lineText: trimmedLine,
              contextAfter: lineNo < lines.length - 1 ? lines[lineNo + 1].trim() : '',
              charOffset: lineStartOffset + leadingWhitespace + start,
            });
            if (fileMatches.length >= MarkdownWysiwygProvider.CROSS_FILE_SEARCH_MAX_MATCHES_PER_FILE_SCAN) {
              hitFileScanCap = true;
              break;
            }
          }
          lineStartOffset += rawLine.length + 1;
        }

        if (fileMatches.length === 0) {
          continue; // file không có match không tính vào cap 5 nhóm
        }
        const segments = uri.path.split('/');
        groups.push({
          uri: uri.toString(),
          fileName: segments[segments.length - 1],
          relativePath: vscode.workspace.asRelativePath(uri, false),
          totalInFile: fileMatches.length,
          fileLength: text.length,
          matches: fileMatches.slice(0, MarkdownWysiwygProvider.CROSS_FILE_SEARCH_MAX_MATCHES_PER_FILE_DISPLAY),
        });
        totalMatches += fileMatches.length;
      }

      return { groups, truncated, total: totalMatches };
    };

    let result = await scan(options);
    let usedFallback = false;
    // Fallback server-side (C4, chốt #4): Whole Word bật mà 0 kết quả trên toàn
    // bộ file ⇒ quét lại toàn bộ theo substring (vẫn tôn trọng matchCase) trong
    // CÙNG round-trip, trả usedFallback=true để webview báo + đồng bộ toggle.
    // Chỉ 0-total mới kích hoạt; tìm được dù chỉ 1 match thì KHÔNG fallback.
    if (options.wholeWord && result.total === 0) {
      result = await scan({ matchCase: options.matchCase, wholeWord: false });
      usedFallback = true;
    }

    // US-15.7: xếp hạng theo mức độ liên quan (fileScore) thay vì giữ nguyên
    // thứ tự findFiles trả về. `uris.length` = tổng file đủ điều kiện quét nội
    // dung, dùng làm mẫu số idf trong rankFileGroups.
    const rankedGroups = rankFileGroups(result.groups, query, uris.length);

    return { groups: rankedGroups, truncated: result.truncated, usedFallback };
  }

  /** Đuôi file tương ứng mỗi MIME ảnh clipboard hỗ trợ — SVG cố ý bỏ qua (kịch bản khai thác XSS/script trong SVG dán từ clipboard không đáng để đánh đổi). */
  private static readonly PASTE_IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
  };

  /** Đoạn giữa cố định của tên file ảnh dán — dùng để nhận diện file "của cleanup" khi liệt kê thư mục. */
  private static readonly PASTE_IMAGE_MARKER = 'pasted-image-';

  /**
   * Thư mục lưu ảnh dán / ảnh-file kéo thả, theo setting `orcaEditor.assetsPaste.location`
   * (US-17.6, M4 — đổi từ `orcaEditor.pasteImage.*` + mặc định `images/` → `assets/`;
   * KHÔNG migrate ảnh cũ, chỉ đổi đích cho ảnh/file MỚI — quyết định 2026-07-15):
   *  - siblingAssetsFolder (mặc định): thư mục con `assets/` cạnh file .md.
   *  - customFolder: thư mục ở `customFolderPath` (tuyệt đối, hoặc tương đối
   *    so với workspace folder chứa document).
   * Dùng chung bởi savePastedImage/saveDroppedFile (ghi file) và cleanupOrphanImages (quét).
   */
  private resolveAssetsDir(document: vscode.TextDocument): vscode.Uri {
    const documentDir = vscode.Uri.joinPath(document.uri, '..');
    const cfg = vscode.workspace.getConfiguration('orcaEditor.assetsPaste', document.uri);
    const location = cfg.get<'siblingAssetsFolder' | 'customFolder'>('location', 'siblingAssetsFolder');
    const customFolderPath = cfg.get<string>('customFolderPath', '').trim();

    if (location === 'customFolder' && customFolderPath) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
      const base = workspaceFolder?.uri ?? documentDir;
      return path.isAbsolute(customFolderPath)
        ? vscode.Uri.file(customFolderPath)
        : vscode.Uri.joinPath(base, customFolderPath);
    }
    return vscode.Uri.joinPath(documentDir, 'assets');
  }

  /**
   * resolveAssetsDir + isInsideAllowedRoots guard shared by savePastedImage /
   * saveDroppedFile / cleanupOrphanImages: returns the assets dir only when it
   * sits inside the allowed workspace roots, else undefined so a mis-configured
   * customFolderPath cannot write/scan outside. Each caller keeps its own bail.
   */
  private async resolveAllowedAssetsDir(document: vscode.TextDocument): Promise<vscode.Uri | undefined> {
    const dir = this.resolveAssetsDir(document);
    return (await this.isInsideAllowedRoots(document, dir)) ? dir : undefined;
  }

  /**
   * Prefix tên file ảnh suy ra từ basename document — gắn "quyền sở hữu" ảnh
   * vào 1 file .md mà không cần lưu index riêng (xem imageNamePrefix). Rỗng
   * khi basename không chuẩn hoá được (vd toàn CJK) — cleanupOrphanImages bỏ
   * qua document đó (không đủ cơ sở xác định ảnh nào thuộc về nó).
   */
  private imagePrefixFor(document: vscode.TextDocument): string {
    return imageNamePrefix(path.basename(document.fileName, path.extname(document.fileName)));
  }

  /**
   * Lưu ảnh dán từ clipboard (case 'pasteImage') thành file thật.
   * Tái dùng isInsideAllowedRoots (như openLink) để customFolderPath cấu hình
   * sai/trỏ ra ngoài workspace không thể ghi file ra ngoài phạm vi cho phép.
   * Tên file có prefix theo basename document (C4: xem cleanupOrphanImages) để
   * dọn ảnh mồ côi khi save không cần quét nội dung mọi file .md khác.
   * Trả về đường dẫn tương đối (chưa mã hoá URL — webview tự encodeLinkPath
   * trước khi chèn, giống quy ước searchWorkspaceFiles) để webview chèn
   * <img src="...">; trả `error` (không có relativePath) khi thất bại.
   */
  private async savePastedImage(
    document: vscode.TextDocument,
    mime: string,
    dataBase64: string
  ): Promise<{ relativePath?: string; error?: string }> {
    const ext = MarkdownWysiwygProvider.PASTE_IMAGE_EXTENSIONS[mime];
    if (!ext) {
      return { error: `Unsupported clipboard image type: ${mime}` };
    }

    const documentDir = vscode.Uri.joinPath(document.uri, '..');
    const targetDir = await this.resolveAllowedAssetsDir(document);
    if (!targetDir) {
      return { error: 'Configured paste-image folder is outside the allowed workspace.' };
    }

    const prefix = this.imagePrefixFor(document);
    const fileName = `${prefix ? prefix + '-' : ''}${MarkdownWysiwygProvider.PASTE_IMAGE_MARKER}${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const targetUri = vscode.Uri.joinPath(targetDir, fileName);

    try {
      await vscode.workspace.fs.createDirectory(targetDir);
      await vscode.workspace.fs.writeFile(targetUri, Buffer.from(dataBase64, 'base64'));
    } catch (err) {
      MarkdownWysiwygProvider.log(`Failed to save pasted image to ${targetUri.toString()}`, err);
      return { error: 'Failed to save pasted image.' };
    }

    return { relativePath: relativePath(documentDir.path, targetUri.path) };
  }

  /**
   * Save a non-image file dropped from outside the editor (US-17.6, M4) into
   * the same `assets/` folder as pasted images (resolveAssetsDir) — unlike
   * pasted images, which get a generated + prefixed name for orphan-cleanup
   * bookkeeping, dropped files keep their ORIGINAL name (so a linked
   * `report.pdf` reads as `report.pdf`, not a hash) with a numeric suffix
   * added only if that name is already taken. Because they carry no marker,
   * orphan cleanup tracks them per-document in memory (trackDroppedAsset) so
   * deleting the link removes + caches the file the same way pasted images are
   * handled (cleanupOrphanImages / restoreUndoneImageDeletions).
   */
  private async saveDroppedFile(
    document: vscode.TextDocument,
    name: string,
    dataBase64: string
  ): Promise<{ relativePath?: string; error?: string }> {
    const documentDir = vscode.Uri.joinPath(document.uri, '..');
    const targetDir = await this.resolveAllowedAssetsDir(document);
    if (!targetDir) {
      return { error: 'Configured assets folder is outside the allowed workspace.' };
    }

    try {
      await vscode.workspace.fs.createDirectory(targetDir);
      const targetUri = await this.uniqueAssetUri(targetDir, sanitizeDroppedFileName(name));
      await vscode.workspace.fs.writeFile(targetUri, Buffer.from(dataBase64, 'base64'));
      this.trackDroppedAsset(document, path.basename(targetUri.path));
      return { relativePath: relativePath(documentDir.path, targetUri.path) };
    } catch (err) {
      MarkdownWysiwygProvider.log(`Failed to save dropped file (${name})`, err);
      return { error: 'Failed to save dropped file.' };
    }
  }

  /** First non-colliding "name.ext" / "name (2).ext" / "name (3).ext"... under `dir`. */
  private async uniqueAssetUri(dir: vscode.Uri, fileName: string): Promise<vscode.Uri> {
    const ext = path.extname(fileName);
    const stem = fileName.slice(0, fileName.length - ext.length);
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? fileName : `${stem} (${n})${ext}`;
      const uri = vscode.Uri.joinPath(dir, candidate);
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        return uri; // stat threw → doesn't exist yet
      }
    }
  }

  /**
   * Bytes của ảnh vừa bị cleanupOrphanImages xoá cứng, giữ tạm trong bộ nhớ để
   * restoreUndoneImageDeletions có thể ghi lại file thật ngay khi tên file đó
   * xuất hiện lại trong document (undo xoá ảnh, hoặc paste lại đúng ảnh cũ) —
   * xử lý y như đang paste ảnh mới, không cần trash trên đĩa (C5). Cap kích
   * thước để không phình bộ nhớ nếu người dùng xoá nhiều ảnh trong 1 phiên mà
   * không bao giờ undo; key là tên file (đã unique nhờ hash ngẫu nhiên trong
   * savePastedImage nên không cần phân biệt theo document).
   */
  private static readonly MAX_RECENTLY_DELETED_IMAGES = 20;
  private readonly recentlyDeletedImages = new Map<string, Uint8Array>();

  private rememberDeletedImage(fileName: string, bytes: Uint8Array): void {
    this.recentlyDeletedImages.set(fileName, bytes);
    while (this.recentlyDeletedImages.size > MarkdownWysiwygProvider.MAX_RECENTLY_DELETED_IMAGES) {
      const oldest = this.recentlyDeletedImages.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.recentlyDeletedImages.delete(oldest);
    }
  }

  /**
   * File kéo-thả (không phải ảnh) giữ TÊN GỐC nên không mang marker như ảnh dán
   * — theo dõi tên file theo document (chỉ trong phiên) để cleanupOrphanImages
   * biết file nào là asset do lần drop này tạo mà dọn khi link bị xoá. Giới hạn
   * phiên: đóng/mở lại editor sẽ quên (giống ảnh dán trước khi có tính năng).
   */
  private readonly droppedAssetsByDoc = new Map<string, Set<string>>();

  private trackDroppedAsset(document: vscode.TextDocument, fileName: string): void {
    const key = document.uri.toString();
    let set = this.droppedAssetsByDoc.get(key);
    if (!set) {
      set = new Set<string>();
      this.droppedAssetsByDoc.set(key, set);
    }
    set.add(fileName);
  }

  /**
   * Dọn ảnh mồ côi khi save (đăng ký ở onDidSaveTextDocument, xem
   * resolveCustomTextEditor): ảnh do document này "sở hữu" (tên file có
   * prefix từ imagePrefixFor, xem savePastedImage) nhưng không còn xuất hiện
   * trong nội dung vừa lưu → ứng viên mồ côi (vd paste nhầm rồi undo ngay).
   *
   * Trước khi dọn 1 ứng viên, kiểm tra các file .md khác CÙNG THƯ MỤC — nếu
   * bất kỳ file nào còn nhắc tới tên file ảnh đó (dừng ngay khi thấy 1 file,
   * không cần đọc hết), coi là còn dùng và bỏ qua: không xoá, không đổi tên.
   * Sửa nội dung 1 file khác ngoài ý muốn người dùng (để cập nhật lại link)
   * rủi ro hơn hẳn giá trị của việc giữ đúng naming convention.
   *
   * Ứng viên thật sự mồ côi bị xoá cứng ngay (không tạo thư mục trash trên
   * đĩa) — an toàn undo được xử lý riêng bằng cache trong bộ nhớ, xem
   * rememberDeletedImage/restoreUndoneImageDeletions.
   *
   * Giới hạn phạm vi (đánh đổi lấy hiệu năng — không quét toàn bộ thư mục):
   * ảnh dán trước khi tính năng này tồn tại (không có prefix) không được quản
   * lý tự động; tham chiếu chéo từ file .md ngoài thư mục hiện tại cũng không
   * được phát hiện. Mọi lỗi ở đây chỉ log, không làm fail thao tác save.
   */
  private async cleanupOrphanImages(document: vscode.TextDocument): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('orcaEditor.assetsPaste.orphanCleanup', document.uri);
    if (!cfg.get<boolean>('enabled', true)) {
      return;
    }

    const imagesDir = await this.resolveAllowedAssetsDir(document);
    if (!imagesDir) {
      return;
    }

    const text = document.getText();

    // Ứng viên = ảnh dán do document sở hữu (nhận diện qua prefix marker, quét
    // thư mục) ∪ file kéo-thả không phải ảnh (giữ tên gốc, không marker — theo
    // dõi trong phiên qua droppedAssetsByDoc).
    const pool = new Set<string>();

    const prefix = this.imagePrefixFor(document);
    if (prefix) {
      const ownedMarker = `${prefix}-${MarkdownWysiwygProvider.PASTE_IMAGE_MARKER}`;
      try {
        for (const [name, type] of await vscode.workspace.fs.readDirectory(imagesDir)) {
          if (type === vscode.FileType.File && name.startsWith(ownedMarker)) {
            pool.add(name);
          }
        }
      } catch {
        // Chưa có thư mục ảnh — không có ảnh dán để dọn (file drop xử lý bên dưới).
      }
    }

    const dropped = this.droppedAssetsByDoc.get(document.uri.toString());
    if (dropped) {
      for (const name of dropped) {
        pool.add(name);
      }
    }

    // Còn xuất hiện trong nội dung vừa lưu ⇒ đang dùng, bỏ. Chỉ đọc sibling khi
    // thật sự còn ứng viên mồ côi (tránh quét thư mục khi không cần).
    const orphans = [...pool].filter((name) => !text.includes(name));
    if (orphans.length === 0) {
      return;
    }

    const siblingTexts = await this.readSiblingMdTexts(document);
    for (const name of orphans) {
      // Còn được 1 file .md khác nhắc tới ⇒ coi như đang dùng, không xoá/đổi tên.
      if (siblingTexts.some((sibling) => sibling.includes(name))) {
        continue;
      }
      await this.deleteOrphanImage(imagesDir, name);
      dropped?.delete(name); // đã xoá+cache; thôi theo dõi (undo sẽ re-track qua restore).
    }
  }

  /**
   * Nội dung mọi file .md anh em CÙNG THƯ MỤC (bỏ chính document), đọc mỗi file
   * đúng MỘT lần — để cleanupOrphanImages đối chiếu mọi ứng viên trong O(siblings)
   * thay vì mở lại danh sách sibling cho từng ứng viên.
   */
  private async readSiblingMdTexts(document: vscode.TextDocument): Promise<string[]> {
    const documentDir = vscode.Uri.joinPath(document.uri, '..');
    const siblingMdUris = await vscode.workspace.findFiles(new vscode.RelativePattern(documentDir, '*.md'));
    const ownUri = document.uri.toString();
    const texts: string[] = [];
    for (const uri of siblingMdUris) {
      if (uri.toString() === ownUri) {
        continue;
      }
      try {
        texts.push((await vscode.workspace.openTextDocument(uri)).getText());
      } catch (err) {
        MarkdownWysiwygProvider.log(`cleanupOrphanImages: could not read ${uri.toString()}`, err);
      }
    }
    return texts;
  }

  /** Đọc bytes vào recentlyDeletedImages trước khi xoá cứng, để undo sau đó có thể khôi phục (xem restoreUndoneImageDeletions). */
  private async deleteOrphanImage(imagesDir: vscode.Uri, fileName: string): Promise<void> {
    const fileUri = vscode.Uri.joinPath(imagesDir, fileName);
    try {
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      this.rememberDeletedImage(fileName, bytes);
      await vscode.workspace.fs.delete(fileUri, { useTrash: false });
    } catch (err) {
      MarkdownWysiwygProvider.log(`cleanupOrphanImages: failed to delete ${fileName}`, err);
    }
  }

  /**
   * Ghi lại file thật cho ảnh vừa bị cleanupOrphanImages xoá, ngay khi tên
   * file đó xuất hiện lại trong nội dung document — dù do undo (DOM-level
   * trong webview lẫn undo ở cấp TextDocument đều đi qua onDidChangeTextDocument)
   * hay do người dùng dán/gõ lại đúng path cũ. Coi như đang xử lý một lượt
   * paste ảnh mới (C5): không có bước này thì sau khi undo, ảnh hiện lại
   * trong editor nhưng file thật đã mất — save, đóng, mở lại sẽ vỡ ảnh.
   */
  private async restoreUndoneImageDeletions(document: vscode.TextDocument, text: string): Promise<void> {
    if (this.recentlyDeletedImages.size === 0) {
      return;
    }
    const imagesDir = this.resolveAssetsDir(document);
    for (const [fileName, bytes] of this.recentlyDeletedImages) {
      if (!text.includes(fileName)) {
        continue;
      }
      this.recentlyDeletedImages.delete(fileName);
      try {
        await vscode.workspace.fs.createDirectory(imagesDir);
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(imagesDir, fileName), bytes);
        // File kéo-thả (không có marker ảnh dán) vừa khôi phục qua undo → theo
        // dõi lại để lần xoá link kế tiếp vẫn dọn được; ảnh dán tự nhận diện
        // qua marker nên không cần.
        if (!fileName.includes(MarkdownWysiwygProvider.PASTE_IMAGE_MARKER)) {
          this.trackDroppedAsset(document, fileName);
        }
      } catch (err) {
        MarkdownWysiwygProvider.log(`restoreUndoneImageDeletions: failed to restore ${fileName}`, err);
      }
    }
  }

  /**
   * S4: chống thoát khỏi allowed roots qua symlink. Trước khi so path, phân
   * giải symlink bằng fs.promises.realpath cho cả target và root. File không
   * tồn tại (broken link) → realpath ném lỗi → fallback về path đã chuẩn hóa
   * (vẫn chặn được traversal qua ../..).
   */
  private async isInsideAllowedRoots(document: vscode.TextDocument, target: vscode.Uri): Promise<boolean> {
    const roots = [
      vscode.Uri.joinPath(document.uri, '..'),
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
    ];

    // Chỉ phân giải symlink cho scheme file; scheme khác giữ path chuẩn hóa.
    const canonical = async (uri: vscode.Uri): Promise<string> => {
      const normalized = uri.path.replace(/\/+$/, '');
      if (uri.scheme !== 'file') {
        return normalized;
      }
      try {
        // Cố ý: chính hàm canonical() cần phân giải symlink của đường dẫn để
        // so khớp allowlist openLink; fsPath đến từ vscode.Uri (không phải input
        // thô của người dùng), không có chèn shell/lệnh nào ở đây.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        return await fs.promises.realpath(uri.fsPath);
      } catch {
        // File chưa tồn tại — dùng path gốc đã chuẩn hóa làm fallback.
        return uri.fsPath.replace(/[/\\]+$/, '');
      }
    };

    const targetPath = (await canonical(target)) + '/';
    for (const root of roots) {
      const rootPath = (await canonical(root)) + '/';
      if (targetPath.startsWith(rootPath)) {
        return true;
      }
    }
    return false;
  }

  private getHtml(
    webview: vscode.Webview,
    documentDir: vscode.Uri,
    readability: ReadabilityConfig
  ): string {
    const distUri = (...parts: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', ...parts));

    const nonce = getNonce();
    const baseHref = `${webview.asWebviewUri(documentDir)}/`;

    const csp = [
      "default-src 'none'",
      // S2: bỏ `https:` khỏi img-src — ảnh chỉ được nạp từ webview resource
      // roots (đã thu hẹp ở S6) và data: URI, không cho fetch ảnh từ web tùy ý.
      `img-src ${webview.cspSource} data:`,
      // S3: giữ 'unsafe-inline' cho style vì render markdown (KaTeX, style tô
      // màu, v.v.) cần inline style. Residual risk: nội dung .md độc hại có thể
      // tiêm CSS (vd đổi giao diện, ẩn nội dung) — không thoát ra ngoài webview
      // và không chạy script được vì script-src chỉ nhận nonce.
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
      // chặn <base> tiêm từ nội dung markdown đổi gốc phân giải tài nguyên
      `base-uri ${webview.cspSource}`,
      // S1: chặn submit form (không có backend hợp lệ nào để gửi tới)
      "form-action 'none'",
      // S1: chặn nhúng iframe/frame từ nội dung markdown
      "frame-src 'none'",
    ].join('; ');

    // Bug 0715 (US-19.9): class trạng thái đọc phải có mặt NGAY từ first paint
    // — nếu chờ message 'init' mới áp (readability.applyFromHost) thì toolbar
    // hiện ra một nhịp rồi trượt lên (transition của .reading-zen) và nội dung
    // giật vì toolbar rời flow. Giá trị preset/palette luôn được whitelist
    // trước khi tới đây — đường settings qua readReadabilityConfig, đường
    // message qua handler 'readingModeChanged' (S-1) — nên an toàn để nội suy
    // vào attribute.
    // bug_General #1: reading styling (reading-mode/preset/palette) gate CHỈ
    // theo `enabled` — Zen KHÔNG kéo theo (khớp stylingActive() ở readability.ts).
    // `reading-zen` (ẩn toolbar/gutter) vẫn bake độc lập theo `zen`.
    const stylingActive = readability.enabled;
    const bodyClasses = [
      ...(stylingActive ? ['reading-mode'] : []),
      ...(readability.zen ? ['reading-zen'] : []),
      // US-19.18: palette giờ gate theo stylingActive giống preset (không còn
      // là lớp GLOBAL độc lập của US-19.11) — tắt Reading Mode = tắt luôn màu.
      ...(stylingActive && readability.palette !== 'followTheme' ? [`reading-palette-${readability.palette}`] : []),
    ].join(' ');
    const contentClasses = stylingActive ? `reading-preset-${readability.preset}` : '';
    // Bug 0716 #1: class `reading-zen` ở trên chỉ ẨN toolbar khi editor.css
    // (external stylesheet) đã load/parse xong. Nếu file CSS này apply SAU
    // khi toolbar đã kịp paint ở trạng thái mặc định (không transform), trình
    // duyệt coi đó là 1 thay đổi giá trị thật và chạy transition của chính
    // rule đó — toolbar hiện ra rồi trượt lên, đúng triệu chứng report. Bake
    // thẳng style ẩn (khớp 1:1 với `body.reading-zen #toolbar`, editor.css)
    // vào inline attribute để first paint không phụ thuộc thời điểm CSS load.
    // JS (readability.ts) vẫn là chủ sở hữu class/transition sau init — style
    // inline chỉ là seed cho khung hình đầu tiên.
    const toolbarStyle = readability.zen
      ? ' style="position:fixed;top:0;left:0;right:0;margin:0;z-index:200;transform:translateY(-100%);pointer-events:none;"'
      : '';

    return /* html */ `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <base href="${baseHref}">
  <link rel="stylesheet" href="${distUri('webview', 'katex', 'katex.min.css')}">
  <link rel="stylesheet" href="${distUri('webview', 'markdown.css')}">
  <link rel="stylesheet" href="${distUri('webview', 'editor.css')}">
  <title>Markdown WYSIWYG Preview</title>
</head>
<body class="${bodyClasses}">
  <div id="toolbar" role="toolbar" aria-label="Formatting toolbar"${toolbarStyle}></div>
  <div id="line-gutter" aria-hidden="true"></div>
  <div id="content" class="${contentClasses}" role="main" aria-label="Document content" contenteditable="true" spellcheck="false"></div>
  <script nonce="${nonce}" src="${distUri('webview', 'main.js')}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  // S7: dùng CSPRNG thay cho Math.random để nonce không đoán được.
  return crypto.randomBytes(16).toString('base64');
}

/** Giá trị hợp lệ của preset/palette — settings.json có thể chứa chuỗi tùy ý,
 * phải whitelist trước khi nội suy vào class attribute của HTML (getHtml). */
const READING_PRESETS: readonly ReadingPreset[] = ['comfortable', 'default', 'compact', 'dyslexia', 'academic'];
const READING_PALETTES: readonly ReadingPalette[] = ['followTheme', 'light', 'dark', 'sepia', 'highContrast', 'paper'];

/** Đọc trạng thái Reading Mode (US-19.x) từ config `orcaEditor.readability.*`. */
function readReadabilityConfig(cfg: vscode.WorkspaceConfiguration): ReadabilityConfig {
  const preset = cfg.get<ReadingPreset>('readability.preset', 'comfortable');
  const palette = cfg.get<ReadingPalette>('readability.palette', 'followTheme');
  return {
    enabled: cfg.get<boolean>('readability.enabled', false),
    preset: READING_PRESETS.includes(preset) ? preset : 'comfortable',
    palette: READING_PALETTES.includes(palette) ? palette : 'followTheme',
    fontFamily: cfg.get<string>('readability.fontFamily', ''),
    zen: cfg.get<boolean>('readability.zen', false),
  };
}
