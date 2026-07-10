import * as vscode from 'vscode';

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

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const webview = webviewPanel.webview;
    const documentDir = vscode.Uri.joinPath(document.uri, '..');

    const localResourceRoots = [
      vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
      documentDir,
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
    ];

    webview.options = { enableScripts: true, localResourceRoots };
    webview.html = this.getHtml(webview, documentDir);

    /** Văn bản cuối cùng mà webview đẩy lên qua 'edit' — dùng để chặn echo. */
    let lastTextFromWebview: string | undefined;

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
      void webview.postMessage({ type: 'update', text });
    });

    const messageSubscription = webview.onDidReceiveMessage(async (msg: { type: string; [k: string]: unknown }) => {
      switch (msg.type) {
        case 'ready': {
          const cfg = vscode.workspace.getConfiguration('markdown.preview', document.uri);
          const editorCfg = vscode.workspace.getConfiguration('editor', document.uri);
          const wysiwygCfg = vscode.workspace.getConfiguration('markdownWysiwyg', document.uri);
          void webview.postMessage({
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
          const text = String(msg.text ?? '');
          lastTextFromWebview = text;
          const ok = await this.applyMinimalEdit(document, text);
          if (!ok) {
            lastTextFromWebview = undefined;
          }
          break;
        }
        case 'openLink': {
          void this.openLink(document, String(msg.href ?? ''));
          break;
        }
        case 'searchFiles': {
          const files = await this.searchWorkspaceFiles(document, String(msg.query ?? ''));
          void webview.postMessage({ type: 'fileSearchResult', requestId: msg.requestId, files });
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
      changeSubscription.dispose();
      messageSubscription.dispose();
    });
  }

  /** Áp dụng newText bằng một edit nhỏ nhất (common prefix/suffix diff). */
  private async applyMinimalEdit(document: vscode.TextDocument, newText: string): Promise<boolean> {
    const oldText = document.getText();
    if (oldText === newText) {
      return true;
    }

    let start = 0;
    const minLen = Math.min(oldText.length, newText.length);
    while (start < minLen && oldText.charCodeAt(start) === newText.charCodeAt(start)) {
      start++;
    }
    let oldEnd = oldText.length;
    let newEnd = newText.length;
    while (oldEnd > start && newEnd > start && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)) {
      oldEnd--;
      newEnd--;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(document.positionAt(start), document.positionAt(oldEnd)),
      newText.slice(start, newEnd)
    );
    return vscode.workspace.applyEdit(edit);
  }

  /** Chỉ các scheme này được mở ra ngoài — chặn ms-msdt:, vscode:, command:... */
  private static readonly SAFE_SCHEMES = new Set(['http', 'https', 'mailto']);

  private async openLink(document: vscode.TextDocument, href: string): Promise<void> {
    if (!href) {
      return;
    }
    const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(href);
    if (schemeMatch) {
      // URL tuyệt đối: chỉ cho phép allowlist (markdown-it validateLink không
      // áp dụng cho raw HTML anchor nên phải tự chặn ở đây).
      if (!MarkdownWysiwygProvider.SAFE_SCHEMES.has(schemeMatch[1].toLowerCase())) {
        void vscode.window.showWarningMessage(`Đã chặn liên kết có scheme không an toàn: ${schemeMatch[1]}:`);
        return;
      }
      try {
        await vscode.env.openExternal(vscode.Uri.parse(href, true));
      } catch {
        /* href không hợp lệ — bỏ qua */
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
    if (!this.isInsideAllowedRoots(document, target)) {
      void vscode.window.showWarningMessage(`Đã chặn liên kết trỏ ra ngoài workspace: ${href}`);
      return;
    }
    try {
      await vscode.commands.executeCommand('vscode.open', target);
    } catch {
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
      let tabs = this.findClaudeChatTabs();
      let visibleChat = tabs.find((t) => t.isActive);
      if (!visibleChat && tabs.length > 0) {
        await this.revealTab(tabs[0]);
        await delay(300); // chờ webview thành visible
        visibleChat = this.findClaudeChatTabs().find((t) => t.isActive);
      } else if (tabs.length === 0 && available.includes('claude-vscode.editor.openLast')) {
        await vscode.commands.executeCommand('claude-vscode.editor.openLast');
        await delay(700); // chờ webview chat khởi tạo xong
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
    } catch {
      /* rơi xuống fallback clipboard */
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
    await delay(150);
    await vscode.commands.executeCommand(insertCmd);

    if (!openedByUser) {
      await delay(250); // chờ chat panel reveal xong
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
    const uris = await vscode.workspace.findFiles(
      '**/*',
      MarkdownWysiwygProvider.FILE_SEARCH_EXCLUDE,
      MarkdownWysiwygProvider.FILE_SEARCH_MAX_SCAN
    );

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

  private isInsideAllowedRoots(document: vscode.TextDocument, target: vscode.Uri): boolean {
    const roots = [
      vscode.Uri.joinPath(document.uri, '..'),
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
    ];
    const targetPath = target.path.replace(/\/+$/, '') + '/';
    return roots.some((root) => {
      const rootPath = root.path.replace(/\/+$/, '') + '/';
      return targetPath.startsWith(rootPath);
    });
  }

  private getHtml(webview: vscode.Webview, documentDir: vscode.Uri): string {
    const distUri = (...parts: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', ...parts));

    const nonce = getNonce();
    const baseHref = `${webview.asWebviewUri(documentDir)}/`;

    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
      // chặn <base> tiêm từ nội dung markdown đổi gốc phân giải tài nguyên
      `base-uri ${webview.cspSource}`,
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

/**
 * Chuẩn hóa chuỗi để so khớp tên file: thường hóa, bỏ dấu tiếng Việt
 * (kể cả đ→d vì NFD không tách được), mọi ký tự khác chữ/số thành '-'.
 */
function normalizeForSearch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Đường dẫn tương đối từ thư mục fromDir tới file toFile (cùng scheme file). */
function relativePath(fromDir: string, toFile: string): string {
  const from = fromDir.split('/').filter(Boolean);
  const to = toFile.split('/').filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) {
    common++;
  }
  const up: string[] = new Array(from.length - common).fill('..');
  return [...up, ...to.slice(common)].join('/');
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
