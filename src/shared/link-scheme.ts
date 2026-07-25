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
 * RAW (`\` `/`) AND percent-encoded (`%5C` `%2F`) form — kept defensive for any
 * href reaching this function already percent-encoded from elsewhere, even
 * though `render.ts` no longer produces that form itself (markdown-it's
 * normalizeLink, which used to encode backslash into `%5C`, is disabled — X-7
 * UNC round-trip fix; classification here works directly off the raw form).
 */
export function isWindowsDrivePath(href: string): boolean {
  return /^[a-zA-Z]:([\\/]|%5c|%2f)/i.test(href);
}

/**
 * A Windows UNC network path (`\\server\share\x.md`) — an absolute LOCAL/network
 * filesystem target, NOT a URL scheme and NOT workspace-relative. Matches 1 OR 2
 * leading backslashes followed by a non-backslash char: CommonMark's own
 * backslash-escape rule collapses a hand-typed `\\server\...` (2 backslashes) down
 * to a SINGLE backslash by the time it reaches a parsed href (`\\` is an escaped
 * literal `\`) — requiring exactly 2 here meant a naturally-authored UNC link was
 * NEVER classified as UNC, silently falling into the relative/workspace-joined
 * branch instead (X-7 follow-up, root cause B). The single forward-slash form
 * `//server/share` is intentionally excluded: in an href it reads as a
 * protocol-relative URL, not a filesystem path.
 */
export function isWindowsUncPath(href: string): boolean {
  return /^\\{1,2}[^\\]/.test(href);
}

/**
 * True iff `href` starts with a real URL scheme (`http:`, `https:`, `mailto:`,
 * `vscode:`…) and is NOT a Windows drive path. `C:\…` is local, not scheme `c:`.
 */
export function hasUrlScheme(href: string): boolean {
  return !isWindowsDrivePath(href) && /^[a-z][a-z0-9+.-]*:/i.test(href);
}
