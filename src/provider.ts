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

/**
 * Trễ (ms) khi phối hợp với extension Claude Code. Đây là các HEURISTIC mong
 * manh: không có tín hiệu "đã sẵn sàng" nào để chờ, nên phải đợi cứng cho
 * webview/panel của Claude khởi tạo hoặc reveal xong trước bước kế. Máy chậm
 * hoặc Claude Code đổi thời gian khởi tạo có thể làm các mốc này không còn đủ
 * — chỉnh khi thấy chèn @mention thỉnh thoảng trượt. (finding C9)
 *
 * Không dùng media/webview/constants.ts: file này thuộc bundle Node của
 * extension, tách biệt với bundle webview.
 */
/** Chờ tab chat Claude có sẵn thành visible sau khi reveal. */
const CLAUDE_REVEAL_DELAY_MS = 300;
/** Chờ webview chat Claude vừa mở khởi tạo xong. */
const CLAUDE_OPEN_DELAY_MS = 700;
/** Chờ text editor tạm mở xong trước khi chạy insertAtMention. */
const CLAUDE_TEMP_EDITOR_DELAY_MS = 150;
/** Chờ chat panel reveal xong trước khi đóng text editor tạm. */
const CLAUDE_PANEL_REVEAL_DELAY_MS = 250;

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
   * C6a: vị trí "chờ áp dụng" cho 1 uri — set trước khi gọi vscode.openWith
   * (panel .md CHƯA tồn tại), đọc + xoá đúng 1 lần khi resolveCustomTextEditor
   * gửi message 'init' cho document đó. Dùng một lần: nếu không xoá ngay, mở
   * lại file này sau đó (không qua cross-file-search) sẽ vô tình áp lại vị trí
   * cũ.
   */
  private pendingReveal = new Map<string, { line: number; character: number; length: number; matchText?: string }>();

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
    let panelsForUri = this.panelsByUri.get(docUriStr);
    if (!panelsForUri) {
      panelsForUri = new Set();
      this.panelsByUri.set(docUriStr, panelsForUri);
    }
    panelsForUri.add(webviewPanel);

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
    // rồi trượt lên (animation trượt chỉ dành cho user bấm nút Focus).
    const initialReadability = readReadabilityConfig(
      vscode.workspace.getConfiguration('orcaEditor', document.uri)
    );
    webview.html = this.getHtml(webview, documentDir, initialReadability);

    /** Văn bản cuối cùng mà webview đẩy lên qua 'edit' — dùng để chặn echo. */
    let lastTextFromWebview: string | undefined;

    // P-01: debounce các thay đổi document dồn dập (git checkout, format, gõ ở
    // text editor bên ngoài) để gộp thành một lần postMessage 'update'.
    const UPDATE_DEBOUNCE_MS = 120;
    let updateTimer: ReturnType<typeof setTimeout> | undefined;

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
    // cần đóng/mở lại preview (claudeAutoInsert không cần vì đã đọc live ở
    // addToClaudeContext, tại thời điểm bấm nút).
    const configSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('orcaEditor', document.uri)) {
        return;
      }
      const wysiwygCfg = vscode.workspace.getConfiguration('orcaEditor', document.uri);
      // KHÔNG gửi enabled/preset/zen qua configUpdate: trạng thái đọc per-tab,
      // session-only (bug 0715 mục 4) — chỉ seed 1 lần lúc 'init'. NGOẠI LỆ:
      // palette là theme GLOBAL (US-19.11, bug 0715 mục 3) → bơm palette hiện tại
      // cho mọi tab để đồng bộ màu; webview chỉ áp palette, không đụng state khác.
      void postToWebview({
        type: 'configUpdate',
        autoOpenToc: wysiwygCfg.get<boolean>('autoOpenToc', true),
        showLineNumbers: wysiwygCfg.get<boolean>('showLineNumbers', true),
        palette: wysiwygCfg.get<ReadingPalette>('readability.palette', 'sepia'),
      });
    });

    const messageSubscription = webview.onDidReceiveMessage(async (msg: WebviewToHost) => {
      switch (msg.type) {
        case 'ready': {
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
              readability: readReadabilityConfig(wysiwygCfg),
            },
          });
          break;
        }
        case 'edit': {
          const text = msg.text;
          lastTextFromWebview = text;
          const ok = await this.applyMinimalEdit(document, text);
          if (!ok) {
            lastTextFromWebview = undefined;
          }
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
        case 'addToClaudeContext': {
          void this.addToClaudeContext(document, webviewPanel.viewColumn);
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
          void this.openCrossFileSearchResult(msg.uri, msg.line, msg.character, msg.length, msg.matchText);
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
        case 'setReadingPalette': {
          // US-19.11 (bug 0715 mục 3): palette là theme GLOBAL cho mọi tab .md.
          // Ghi Global → onDidChangeConfiguration ở MỌI panel bắn configUpdate
          // (kèm palette) xuống webview tương ứng → tất cả tab đồng bộ.
          await vscode.workspace
            .getConfiguration('orcaEditor', document.uri)
            .update('readability.palette', msg.palette, vscode.ConfigurationTarget.Global);
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
    uriStr: string,
    line: number,
    character: number,
    length: number,
    matchText?: string
  ): Promise<void> {
    try {
      const uri = vscode.Uri.parse(uriStr);
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

  /**
   * Thêm nhanh file hiện tại vào context chat của Claude Code.
   *
   * Cơ chế phía Claude Code: command insertAtMention đọc activeTextEditor và
   * bắn sự kiện; sự kiện chỉ được xử lý khi ĐÃ có panel chat (consumer gửi
   * "insert_at_mention" vào webview rồi tự reveal panel). Vì vậy thứ tự đúng:
   *   1. Mở latest conversation (claude-vscode.editor.openLast) để chắc chắn
   *      có panel nhận sự kiện, chờ panel khởi tạo.
   *   2. Đưa file về làm activeTextEditor (webview WYSIWYG không được tính).
   *   3. Gọi insertAtMention — chat tự reveal với "@file" trong ô nhập.
   * Không có Claude Code thì fallback copy "@file" vào clipboard.
   */
  /** Tab webview chat của Claude Code — cách nhận diện giống chính Claude Code. */
  private static isClaudeChatTab(tab: vscode.Tab): boolean {
    return (
      tab.input instanceof vscode.TabInputWebview &&
      (tab.input as vscode.TabInputWebview).viewType.includes('claudeVSCodePanel')
    );
  }

  private findClaudeChatTabs(): vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter(MarkdownWysiwygProvider.isClaudeChatTab);
  }

  /**
   * Điều hướng tới một tab bất kỳ: focus đúng editor group theo viewColumn,
   * rồi chọn tab theo vị trí trong group (cơ chế như phím Ctrl/Alt+1..9).
   */
  private async revealTab(tab: vscode.Tab): Promise<void> {
    const FOCUS_GROUP_COMMANDS = [
      'workbench.action.focusFirstEditorGroup',
      'workbench.action.focusSecondEditorGroup',
      'workbench.action.focusThirdEditorGroup',
      'workbench.action.focusFourthEditorGroup',
      'workbench.action.focusFifthEditorGroup',
      'workbench.action.focusSixthEditorGroup',
      'workbench.action.focusSeventhEditorGroup',
      'workbench.action.focusEighthEditorGroup',
    ];
    const column = tab.group.viewColumn;
    if (column >= 1 && column <= FOCUS_GROUP_COMMANDS.length) {
      await vscode.commands.executeCommand(FOCUS_GROUP_COMMANDS[column - 1]);
    }
    const index = tab.group.tabs.indexOf(tab);
    if (index >= 0 && index < 9) {
      await vscode.commands.executeCommand(`workbench.action.openEditorAtIndex${index + 1}`);
      return;
    }
    // Group có hơn 9 tab — duyệt tuần tự tới khi tab chat thành active
    for (let i = 0; i < tab.group.tabs.length; i++) {
      const active = vscode.window.tabGroups.all.find((g) => g.viewColumn === column)?.activeTab;
      if (active && MarkdownWysiwygProvider.isClaudeChatTab(active)) {
        return;
      }
      await vscode.commands.executeCommand('workbench.action.nextEditorInGroup');
    }
  }

  private async addToClaudeContext(document: vscode.TextDocument, panelColumn?: vscode.ViewColumn): Promise<void> {
    const mention = `@${vscode.workspace.asRelativePath(document.uri, false)}`;
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    try {
      const available = await vscode.commands.getCommands(true);

      // 1) Đảm bảo tab chat Claude đang hiển thị: reveal tab có sẵn (giữ nguyên
      //    hội thoại), chỉ mở mới khi chưa có chat nào.
      const tabs = this.findClaudeChatTabs();
      let visibleChat = tabs.find((t) => t.isActive);
      if (!visibleChat && tabs.length > 0) {
        await this.revealTab(tabs[0]);
        await delay(CLAUDE_REVEAL_DELAY_MS);
        visibleChat = this.findClaudeChatTabs().find((t) => t.isActive);
      } else if (tabs.length === 0 && available.includes('claude-vscode.editor.openLast')) {
        await vscode.commands.executeCommand('claude-vscode.editor.openLast');
        await delay(CLAUDE_OPEN_DELAY_MS);
        visibleChat = this.findClaudeChatTabs().find((t) => t.isActive);
      }

      // 2) Tự chèn @mention (mặc định): command insertAtMention của Claude Code
      //    bắt buộc đọc activeTextEditor nên phải mở tạm text editor của file
      //    rồi tự đóng lại — không còn cách nào khác để "paste thẳng" vào
      //    webview của extension khác (VS Code không expose command paste cho
      //    webview; Electron xử lý ⌘V ở tầng native).
      const autoInsert = vscode.workspace
        .getConfiguration('orcaEditor')
        .get<boolean>('claudeAutoInsert', false);
      const insertCmd = ['claude-vscode.insertAtMention', 'claude-code.insertAtMentioned'].find((c) =>
        available.includes(c)
      );
      if (autoInsert && insertCmd) {
        await this.insertMentionViaTempEditor(document, insertCmd, visibleChat, panelColumn);
        vscode.window.setStatusBarMessage(`Đã chèn ${mention} vào chat Claude Code`, 4000);
        return;
      }

      // 3) Mặc định: KHÔNG mở file — copy mention + focus thẳng ô nhập chat,
      //    người dùng chỉ cần ⌘V.
      await vscode.env.clipboard.writeText(`${mention} `);
      if (available.includes('claude-vscode.focus')) {
        await vscode.commands.executeCommand('claude-vscode.focus');
      }
      vscode.window.setStatusBarMessage(`Đã copy "${mention}" — nhấn ⌘V trong ô chat để chèn`, 6000);
      return;
    } catch (err) {
      // C8: log lỗi trước khi rơi xuống fallback clipboard để không nuốt lỗi.
      MarkdownWysiwygProvider.log('addToClaudeContext failed, falling back to clipboard', err);
    }
    await vscode.env.clipboard.writeText(mention);
    void vscode.window.showInformationMessage(
      `Copied "${mention}" — paste it into the Claude chat input to add the file to context.`
    );
  }

  /**
   * Chèn @mention tự động: mở tạm text editor của file (điều kiện bắt buộc để
   * insertAtMention của Claude Code đọc được), chèn xong tự đóng — layout giữ
   * nguyên. Mở ở group KHÁC group chứa chat để không che tab chat (mention chỉ
   * được panel đang hiển thị xử lý).
   */
  private async insertMentionViaTempEditor(
    document: vscode.TextDocument,
    insertCmd: string,
    visibleChat: vscode.Tab | undefined,
    panelColumn?: vscode.ViewColumn
  ): Promise<void> {
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const uriStr = document.uri.toString();
    const findTextTab = () =>
      vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .find((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uriStr);
    // File đã được user tự mở dạng text từ trước thì không đóng của họ
    const openedByUser = findTextTab() !== undefined;

    const chatColumn = visibleChat?.group.viewColumn;
    let targetColumn: vscode.ViewColumn | undefined = panelColumn;
    if (chatColumn !== undefined && (targetColumn === undefined || targetColumn === chatColumn)) {
      targetColumn =
        vscode.window.tabGroups.all.map((g) => g.viewColumn).find((c) => c !== chatColumn) ??
        vscode.ViewColumn.Beside;
    }
    await vscode.window.showTextDocument(document, {
      viewColumn: targetColumn ?? vscode.ViewColumn.Active,
      preview: true,
      preserveFocus: false,
    });
    await delay(CLAUDE_TEMP_EDITOR_DELAY_MS);
    await vscode.commands.executeCommand(insertCmd);

    if (!openedByUser) {
      await delay(CLAUDE_PANEL_REVEAL_DELAY_MS);
      const tempTab = findTextTab();
      if (tempTab) {
        await vscode.window.tabGroups.close(tempTab);
      }
    }
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
    const targetDir = this.resolveAssetsDir(document);

    if (!(await this.isInsideAllowedRoots(document, targetDir))) {
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
   * added only if that name is already taken. Not covered by
   * cleanupOrphanImages — deleting an unused dropped file is manual for now
   * (scope cut: extending orphan detection to arbitrary `[text](path)` links,
   * not just `<img>`, is a larger change deferred to a later pass).
   */
  private async saveDroppedFile(
    document: vscode.TextDocument,
    name: string,
    dataBase64: string
  ): Promise<{ relativePath?: string; error?: string }> {
    const documentDir = vscode.Uri.joinPath(document.uri, '..');
    const targetDir = this.resolveAssetsDir(document);

    if (!(await this.isInsideAllowedRoots(document, targetDir))) {
      return { error: 'Configured assets folder is outside the allowed workspace.' };
    }

    try {
      await vscode.workspace.fs.createDirectory(targetDir);
      const targetUri = await this.uniqueAssetUri(targetDir, sanitizeDroppedFileName(name));
      await vscode.workspace.fs.writeFile(targetUri, Buffer.from(dataBase64, 'base64'));
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

    const imagesDir = this.resolveAssetsDir(document);
    if (!(await this.isInsideAllowedRoots(document, imagesDir))) {
      return;
    }

    const prefix = this.imagePrefixFor(document);
    if (!prefix) {
      return;
    }

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(imagesDir);
    } catch {
      return; // Chưa có thư mục ảnh nào — không có gì để dọn.
    }

    const ownedMarker = `${prefix}-${MarkdownWysiwygProvider.PASTE_IMAGE_MARKER}`;
    const text = document.getText();
    const candidates = entries
      .filter(([name, type]) => type === vscode.FileType.File && name.startsWith(ownedMarker))
      .map(([name]) => name)
      .filter((name) => !text.includes(name));

    if (candidates.length === 0) {
      return;
    }

    const documentDir = vscode.Uri.joinPath(document.uri, '..');
    const siblingMdUris = await vscode.workspace.findFiles(new vscode.RelativePattern(documentDir, '*.md'));

    for (const name of candidates) {
      if (await this.isReferencedInSiblingFiles(name, siblingMdUris, document.uri)) {
        continue;
      }
      await this.deleteOrphanImage(imagesDir, name);
    }
  }

  /** true nếu tìm thấy 1 file .md khác (không phải chính document) còn nhắc tới fileName — dừng ngay, không đọc hết danh sách. */
  private async isReferencedInSiblingFiles(
    fileName: string,
    siblingUris: readonly vscode.Uri[],
    ownDocumentUri: vscode.Uri
  ): Promise<boolean> {
    for (const uri of siblingUris) {
      if (uri.toString() === ownDocumentUri.toString()) {
        continue;
      }
      try {
        const opened = await vscode.workspace.openTextDocument(uri);
        if (opened.getText().includes(fileName)) {
          return true;
        }
      } catch (err) {
        MarkdownWysiwygProvider.log(`cleanupOrphanImages: could not read ${uri.toString()}`, err);
      }
    }
    return false;
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
    // giật vì toolbar rời flow. Giá trị preset/palette đã được whitelist trong
    // readReadabilityConfig nên an toàn để nội suy vào attribute.
    const stylingActive = readability.enabled || readability.zen;
    const bodyClasses = [
      ...(stylingActive ? ['reading-mode'] : []),
      ...(readability.zen ? ['reading-zen'] : []),
      ...(readability.palette !== 'followTheme' ? [`reading-palette-${readability.palette}`] : []),
      ...(stylingActive && readability.linkUnderline ? ['reading-link-underline'] : []),
    ].join(' ');
    const contentClasses = stylingActive ? `reading-preset-${readability.preset}` : '';

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
  <div id="toolbar" role="toolbar" aria-label="Formatting toolbar"></div>
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
  const palette = cfg.get<ReadingPalette>('readability.palette', 'sepia');
  return {
    enabled: cfg.get<boolean>('readability.enabled', true),
    preset: READING_PRESETS.includes(preset) ? preset : 'comfortable',
    palette: READING_PALETTES.includes(palette) ? palette : 'sepia',
    linkUnderline: cfg.get<boolean>('readability.linkUnderline', false),
    fontFamily: cfg.get<string>('readability.fontFamily', ''),
    zen: cfg.get<boolean>('readability.zen', false),
  };
}
