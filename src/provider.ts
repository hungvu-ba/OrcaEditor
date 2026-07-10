import * as vscode from 'vscode';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { HostToWebview, WebviewToHost } from './shared/messages';
import { classifyLink, computeMinimalEdit, normalizeForSearch, relativePath } from './text-utils';

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
  public static readonly viewType = 'markdownWysiwyg.editor';

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
    webview.html = this.getHtml(webview, documentDir);

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

    const messageSubscription = webview.onDidReceiveMessage(async (msg: WebviewToHost) => {
      switch (msg.type) {
        case 'ready': {
          const cfg = vscode.workspace.getConfiguration('markdown.preview', document.uri);
          const editorCfg = vscode.workspace.getConfiguration('editor', document.uri);
          const wysiwygCfg = vscode.workspace.getConfiguration('markdownWysiwyg', document.uri);
          void postToWebview({
            type: 'init',
            text: document.getText(),
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
      }
    });

    webviewPanel.onDidDispose(() => {
      if (updateTimer !== undefined) {
        clearTimeout(updateTimer);
        updateTimer = undefined;
      }
      changeSubscription.dispose();
      messageSubscription.dispose();
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
        void vscode.window.showWarningMessage(`Đã chặn liên kết có scheme không an toàn: ${link.scheme}:`);
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
      void vscode.window.showWarningMessage(`Đã chặn liên kết trỏ ra ngoài workspace: ${href}`);
      return;
    }
    try {
      await vscode.commands.executeCommand('vscode.open', target);
    } catch (err) {
      MarkdownWysiwygProvider.log(`vscode.open failed for target: ${target.toString()}`, err);
      void vscode.window.showWarningMessage(`Không mở được liên kết: ${href}`);
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
        .getConfiguration('markdownWysiwyg')
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
      `Đã copy "${mention}" — dán vào ô chat Claude để thêm file vào context.`
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

  private getHtml(webview: vscode.Webview, documentDir: vscode.Uri): string {
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
<body>
  <div id="toolbar" aria-label="Thanh công cụ định dạng"></div>
  <div id="line-gutter" aria-hidden="true"></div>
  <div id="content" contenteditable="true" spellcheck="false"></div>
  <script nonce="${nonce}" src="${distUri('webview', 'main.js')}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  // S7: dùng CSPRNG thay cho Math.random để nonce không đoán được.
  return crypto.randomBytes(16).toString('base64');
}
