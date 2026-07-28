/**
 * Req 24 US-23.15 AC5: whether a sidecar can actually reach the team it was
 * written for. The whole comment feature's premise is shared review data, so a
 * sidecar that a `.gitignore` rule excludes — or that nobody ever `git add`ed —
 * is a silent dead end: the Reviewer sees their comments, the team never does.
 *
 * No `vscode` import (the state→message map is exercised from `test/unit.ts`),
 * and no knowledge of the sidecar's layout — just a path plus the two `git`
 * questions that answer it.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** What git says about one sidecar path. */
export type SidecarShareState =
  /** Tracked — it reaches the team. */
  | 'shared'
  /** A `.gitignore` rule excludes it. */
  | 'ignored'
  /** Inside a repository, but never added. */
  | 'untracked'
  /** Not in a git repository at all — AC5 is a no-op here. */
  | 'no-repo'
  /**
   * There is no sidecar at this path yet. Asked FIRST, because git answers
   * "untracked" for a file that does not exist — and telling the user to
   * `git add` a file nobody has created would fire on every never-commented
   * document they open (review finding, 2026-07-28).
   */
  | 'no-sidecar'
  /** `git` is missing, timed out, or failed for a reason that is not an answer. */
  | 'unknown';

/**
 * A `git` question must never outlive the action that asked it. Without a bound,
 * a `check-ignore` blocked on a stale `index.lock` or a slow network worktree
 * leaves the promise unsettled forever — and the caller's once-per-path claim
 * with it, silencing AC5 for the rest of the session (review finding).
 */
const GIT_TIMEOUT_MS = 3000;

/**
 * One `git` invocation's outcome. Injected so a test can drive every state
 * without a repository, the same seam shape `SidecarStoreDeps` uses.
 */
export type GitRunner = (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;

const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    // `execFile`, never `exec`: the path is passed as an argv entry, so no shell
    // ever sees it and a filename containing a space/quote/`;` cannot be
    // reinterpreted. Non-zero exits are ANSWERS here (1 = "no"), not failures,
    // so the error argument is deliberately folded into `code`.
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS }, (err, stdout) => {
      const code = (err as (Error & { code?: number }) | null)?.code;
      // A timeout kills the child and reports `killed: true` with no numeric
      // `code`, which lands on -1 below — "no usable answer", never a state.
      resolve({ code: err === null ? 0 : typeof code === 'number' ? code : -1, stdout: String(stdout) });
    });
  });

/**
 * AC5: the reason to warn about `sidecarName`, or null when there is nothing to
 * say. `shared` is the healthy case; `no-repo`/`unknown` stay silent — warning
 * about git outside a git repository, or because `git` is not installed, would
 * be noise the user cannot act on.
 */
export function sidecarShareWarning(state: SidecarShareState, sidecarName: string): string | null {
  switch (state) {
    case 'ignored':
      return `${sidecarName} is excluded by a gitignore rule, so its comments will never reach your team.`;
    case 'untracked':
      return `${sidecarName} is not tracked by git yet — run "git add" on it so its comments reach your team.`;
    case 'shared':
    case 'no-repo':
    case 'no-sidecar':
    case 'unknown':
      return null;
  }
}

/** Whether a sidecar exists at all — see `no-sidecar`. Injected for the same reason `GitRunner` is. */
export type PathProbe = (fsPath: string) => Promise<boolean>;

const realProbe: PathProbe = async (fsPath) => {
  try {
    await fs.promises.access(fsPath);
    return true;
  } catch {
    return false;
  }
};

/**
 * AC5: resolve one sidecar path's state. Ordered ignored-before-untracked on
 * purpose: an ignored file is also absent from `git ls-files`, so asking that
 * question first would report every ignored sidecar as merely "not added yet"
 * and send the user to a `git add` that the ignore rule refuses.
 */
export async function sidecarShareState(
  sidecarFsPath: string,
  git: GitRunner = runGit,
  exists: PathProbe = realProbe
): Promise<SidecarShareState> {
  if (!(await exists(sidecarFsPath))) {
    // Nobody has commented on this document, so there is nothing for the team to
    // be missing. Checked before git, which cannot tell "not added yet" from
    // "does not exist" — both are exit 1 from `ls-files --error-unmatch`.
    return 'no-sidecar';
  }
  const cwd = path.dirname(sidecarFsPath);
  const inRepo = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  if (inRepo.code !== 0) {
    // Exit 128 for "not a git repository", -1 for a missing `git` binary. Both
    // mean AC5 has nothing to check.
    return inRepo.code === -1 ? 'unknown' : 'no-repo';
  }
  if (inRepo.stdout.trim() !== 'true') {
    // Inside a bare repository's directory — no worktree, so no tracked path.
    return 'no-repo';
  }
  const ignored = await git(['check-ignore', '--quiet', '--', sidecarFsPath], cwd);
  if (ignored.code === 0) {
    return 'ignored';
  }
  if (ignored.code !== 1) {
    return 'unknown';
  }
  const tracked = await git(['ls-files', '--error-unmatch', '--', sidecarFsPath], cwd);
  if (tracked.code === 0) {
    return 'shared';
  }
  return tracked.code === 1 ? 'untracked' : 'unknown';
}
