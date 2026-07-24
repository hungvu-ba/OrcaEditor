/**
 * PURE module (regex only — no `vscode`, `fs`, or DOM): the SINGLE source of
 * truth for "does this href carry a URL scheme, or is it a local filesystem
 * path?". Imported by both the extension host (`src/`) and the webview bundle
 * (`media/webview/`, also under domino in round-trip tests), so it must stay
 * pure. Before this module the same question was answered by three private
 * copies that disagreed on a Windows drive letter (audit X-7).
 */

/**
 * A Windows drive-letter path (`C:\dir\x.md` or `C:/dir/x.md`) — a LOCAL
 * filesystem target, NOT a URL scheme. The single `[\\/]` after the colon is
 * what distinguishes it from a real scheme like `c:` (which is never followed
 * by a separator as its first char in practice).
 */
export function isWindowsDrivePath(href: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(href);
}

/**
 * True iff `href` starts with a real URL scheme (`http:`, `https:`, `mailto:`,
 * `vscode:`…) and is NOT a Windows drive path. `C:\…` is local, not scheme `c:`.
 */
export function hasUrlScheme(href: string): boolean {
  return !isWindowsDrivePath(href) && /^[a-z][a-z0-9+.-]*:/i.test(href);
}
