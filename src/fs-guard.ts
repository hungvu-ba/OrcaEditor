/**
 * Filesystem containment helper shared by the extension host's allowed-roots
 * guard (src/provider.ts). Node-only imports (no `vscode`) so test/unit.ts can
 * exercise the logic against real temp-dir symlinks.
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * True when any path segment of `target` STRICTLY BELOW `root` is a symbolic
 * link (Security Audit S-1). The root itself is never checked: reparse points
 * at or above the workspace root (OneDrive Files On-Demand, junctions) must
 * stay tolerated, while attacker-controlled repo content can only introduce
 * symlinks below the root.
 *
 * A target outside the root returns false: there is nothing below the root to
 * inspect — containment itself is the caller's lexical/realpath check, not
 * this walk. A missing segment is safe (`assets/` before the first paste) and
 * ends the walk: nothing deeper can exist. Other lstat errors skip just that
 * segment — this guard only narrows an already-contained path; refusal UX
 * stays with the caller.
 *
 * `caseInsensitive` must mirror the caller's own path-comparison policy
 * (`CASE_INSENSITIVE_FS`). The containment prefix is compared segment by
 * segment rather than through `path.relative`, which is always case-sensitive:
 * with a case-divergent root/target pair — accepted by the caller's folded
 * lexical check on macOS/Windows — `relative` would come back `../..`, the
 * walk would abstain and the write would follow the symlink out unchecked.
 * `lstat` still runs on the caller's raw root spelling.
 *
 * Sync on purpose: callers run on paste/drop/save (not hot paths), and the
 * unit-test runner is CJS without top-level await (see test/unit.ts).
 */
export function pathSegmentsContainSymlink(
  rootFsPath: string,
  targetFsPath: string,
  caseInsensitive = false
): boolean {
  const rootParts = splitSegments(rootFsPath);
  const targetParts = splitSegments(targetFsPath);
  if (targetParts.length <= rootParts.length) {
    return false;
  }
  const sameSegment = (a: string, b: string): boolean =>
    caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
  for (let i = 0; i < rootParts.length; i++) {
    if (!sameSegment(rootParts[i], targetParts[i])) {
      return false;
    }
  }

  let current = path.resolve(rootFsPath);
  for (let i = rootParts.length; i < targetParts.length; i++) {
    const segment = targetParts[i];
    if (!segment || segment === '.') {
      continue;
    }
    current = path.join(current, segment);
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      if (fs.lstatSync(current).isSymbolicLink()) {
        return true;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      // Unreadable segment (permissions, transient FS error): treat as safe —
      // the path is already lexically contained; keep walking the rest.
    }
  }
  return false;
}

/** Absolute path → its segments, with any trailing empty segment dropped so a
 *  root spelled with a trailing separator compares equal to one without. */
function splitSegments(fsPath: string): string[] {
  const parts = path.resolve(fsPath).split(path.sep);
  while (parts.length > 1 && parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
}
