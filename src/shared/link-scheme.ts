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
 * filesystem target, NOT a URL scheme. The separator right after the colon is
 * what distinguishes it from a real scheme like `c:` (which is never followed
 * by a separator as its first char in practice). The separator is matched in
 * RAW (`\` `/`) AND percent-encoded (`%5C` `%2F`) form, because markdown-it's
 * normalizeLink encodes a backslash href — an authored `[x](C:\d\x.md)` renders
 * `href="C:%5Cd%5Cx.md"`, and that is the string the click / inline-marker paths
 * classify (X-7 follow-up: the raw-only regex misfired it into scheme `c:`).
 */
export function isWindowsDrivePath(href: string): boolean {
  return /^[a-zA-Z]:([\\/]|%5c|%2f)/i.test(href);
}

/**
 * A Windows UNC network path (`\\server\share\x.md`) — an absolute LOCAL/network
 * filesystem target, NOT a URL scheme and NOT workspace-relative. Two leading
 * backslashes followed by a server name (X-7 deferred follow-up). The single
 * forward-slash form `//server/share` is intentionally excluded: in an href it
 * reads as a protocol-relative URL, not a filesystem path.
 */
export function isWindowsUncPath(href: string): boolean {
  return /^\\\\[^\\]/.test(href);
}

/**
 * True iff `href` starts with a real URL scheme (`http:`, `https:`, `mailto:`,
 * `vscode:`…) and is NOT a Windows drive path. `C:\…` is local, not scheme `c:`.
 */
export function hasUrlScheme(href: string): boolean {
  return !isWindowsDrivePath(href) && /^[a-z][a-z0-9+.-]*:/i.test(href);
}
