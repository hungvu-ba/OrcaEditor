#!/usr/bin/env python3
"""Plan check. Task prompt facts vs repo now -- catch stale prompt before session starts.
Ported from the PZMod repo (tools/plan_check.py) for break-tasks plans (TS / CSS / Markdown).

  python3 scripts/plan_check.py <plan.md> [T1.2 ...] [--rev HEAD] [--all] [-v]

Default = every ☐ task (not started). Per task, from its Code ```text block:
  file    path in Read:/Anchors:/Check against: exists at rev (Steps target may be new = ok)
  sym     `file` `symbol` -- symbol present in that file at rev; `fn(a, b)` arg count vs def
  anchor  quoted "## heading" exists in a doc the prompt names
  req     US-x.y heading exists in ../OrcaEditor-Requirements (named Requirement file, else any)
  dep     task in "Starts when" has a commit tagged (Tx.y) on rev (else: which branch holds it)
  line    file.ts:123 anchor = drifts, use symbol
Paths with spaces must be backticked in the prompt; Requirement files may be bare.
FAIL = prompt states something false now. WARN = check by hand. Exit 1 on any FAIL.
"""
import argparse
import datetime
import glob
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import context_audit as ca  # noqa: E402

ROOT = ca.ROOT
_common = ca.git("rev-parse", "--path-format=absolute", "--git-common-dir").strip()
MAIN_ROOT = os.path.dirname(_common) if _common else ROOT  # main checkout, also from a worktree
REQ_DIR = os.path.normpath(os.path.join(MAIN_ROOT, "..", "OrcaEditor-Requirements"))
TASK_HEAD = re.compile(r"^###\s+(\S)\s+([TF]\d+\.\d+)\b")  # F = human task: status only, no commit
TASK_ID = re.compile(r"\b([TF]\d+\.\d+)\b")
SPACED_PATH = re.compile(r"`([^`\n]* [^`\n]*\.(?:md|ts|css|js|json|py))`")
REQ_FILE = re.compile(r"(?:\.\./OrcaEditor-Requirements/)?(Requirement - \d{2} [^`\"\n#]*?\.md)")
BACKTICK = re.compile(r"`([^`\n]+)`")
TS_IDENT = re.compile(r"^([A-Za-z_$][\w$]*)(?:\(([^()]*)\))?$")
CSS_TOKEN = re.compile(r"^((?:\.|#|--)[\w-]+)(?:\s*\{)?$")
US_ID = re.compile(r"\bUS-(\d+\.\d+)\b")
QUOTED_HEAD = re.compile(r"\"(#{1,4} [^\"]+)\"")
LINE_ANCHOR = re.compile(r"\b[\w/.-]+\.(?:ts|tsx|js|css|md|py):\d+")
NEW_WORD = re.compile(r"\b(add|adds|new|create|creates|introduce|rename to)\b", re.I)
CODE_EXT = (".ts", ".tsx", ".js", ".mjs", ".cjs")


def git(*a):
    return ca.git(*a)


def tasks(plan):
    """plan.md -> [{id, status, start (Starts when), code (prompt text)}]."""
    out, cur, in_code, fence = [], None, False, False
    with open(plan, encoding="utf-8") as fh:
        lines = fh.readlines()
    for line in lines:
        m = TASK_HEAD.match(line)
        if m:
            cur = {"id": m.group(2), "status": m.group(1), "start": "", "code": ""}
            out.append(cur)
            in_code = fence = False
            continue
        if not cur:
            continue
        if line.startswith("**Starts when:**"):
            cur["start"] = line
        elif line.strip() == "Code:":
            in_code = True
        elif in_code and line.startswith("```"):
            if fence:
                in_code = fence = False  # first fence after Code: only
            else:
                fence = True
        elif in_code and fence:
            cur["code"] += line
    return out


class Tree:
    """Repo at rev: file list, file text. Cached per run."""

    def __init__(self, rev):
        self.rev = rev
        self.files = git("ls-tree", "-r", "--name-only", rev).splitlines()
        self._text = {}

    def find(self, path):
        path = path.strip("./`")
        if path in self.files:
            return [path]
        hits = [f for f in self.files if f.endswith("/" + path)]
        if not hits:
            hits = [path] if self.disk(path) else []  # untracked / gitignored (Plan/)
        return hits

    @staticmethod
    def disk(path):
        """Untracked file: this checkout first, then the main checkout (worktree has no Plan/)."""
        for root in (ROOT, MAIN_ROOT):
            if os.path.isfile(os.path.join(root, path)):
                return os.path.join(root, path)
        return None

    def show(self, path):
        if path not in self._text:
            if path in self.files:
                self._text[path] = git("show", "%s:%s" % (self.rev, path))
            else:
                with open(self.disk(path), encoding="utf-8") as fh:
                    self._text[path] = fh.read()
        return self._text[path]


def req_files():
    return sorted(glob.glob(os.path.join(REQ_DIR, "Requirement - *.md")))


def req_text(name):
    p = os.path.join(REQ_DIR, name)
    if not os.path.isfile(p):
        return None
    with open(p, encoding="utf-8") as fh:
        return fh.read()


def files_in(text):
    """Every path token: backticked spaced paths, Requirement files, plain paths (spaced ones masked first)."""
    spaced = SPACED_PATH.findall(text)
    reqs = REQ_FILE.findall(text)
    masked = SPACED_PATH.sub(" ", REQ_FILE.sub(" ", text))
    return spaced, reqs, ca.FILE_RE.findall(masked)


def targets(text):
    """Files a Steps line writes (step head before the first ': '). May not exist yet."""
    out = set()
    for line in re.findall(r"^\s*\d+\.\s+(.*)$", text, re.M):
        head = line.split(": ", 1)[0] if ": " in line[:200] else ""
        spaced, reqs, plain = files_in(head)
        out.update(os.path.basename(f) for f in spaced + reqs + plain)
    return out


def read_orders(text):
    """Text session is TOLD to read: Anchors: lines + everything after Read:/Check against: on its line."""
    parts = re.findall(r"^Anchors:.*$", text, re.M) + re.findall(r"(?:Read|Check against):([^\n]*)", text)
    return "\n".join(parts)


def params_range(sig):
    """'(a: string, b?: number, ...rest)' -> (min, max|None)."""
    depth, cur, parts = 0, "", []
    for ch in sig.replace("=>", "  "):
        if ch in "<{[(":
            depth += 1
        elif ch in ">}])":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    parts = [p.strip() for p in parts if p.strip()]
    if any(p.startswith("...") for p in parts):
        return len([p for p in parts if not p.startswith("...")]), None
    optional = [p for p in parts if re.match(r"[\w$]+\?", p) or "=" in p]
    return len(parts) - len(optional), len(parts)


def ts_def_params(src, name):
    """Param text of `function name(` / `name(...) {` / `name = (...) =>` in src, or None."""
    rx = re.compile(r"(?:function\s*\*?\s*%s|^\s*(?:(?:export|async|static|private|public|protected)\s+)*%s|"
                    r"\b%s\s*[:=]\s*(?:async\s*)?)\s*(?:<[^>]*>)?\s*\(" % ((re.escape(name),) * 3), re.M)
    m = rx.search(src)
    if not m:
        return None
    depth, i = 1, m.end()
    while i < len(src) and depth:
        depth += {"(": 1, ")": -1}.get(src[i], 0)
        i += 1
    return " ".join(src[m.end():i - 1].split())


def symbol_pairs(text):
    """(file, token, line) for each backticked token that follows a file path on the same line."""
    out = []
    for line in text.splitlines():
        cur = None
        for tok in BACKTICK.findall(line):
            spaced, reqs, plain = files_in("`%s`" % tok)
            f = (spaced or plain or [None])[0]
            if f and f.strip("`") == tok.strip():
                cur = f
                continue
            if cur:
                out.append((cur, tok.strip(), line))
    return out


def check(t, tree, status, since):
    text = t["code"]
    tgt = targets(text)
    out = []

    def add(level, kind, msg):
        out.append((level, kind, msg))

    # dep: tasks this one waits on
    unmerged = []
    for dep in sorted(set(TASK_ID.findall(t["start"])) - {t["id"]}):
        if dep.startswith("F"):
            if status.get(dep) != "☑":
                add("WARN", "dep", "%s (human) not ☑ in plan" % dep)
                unmerged.append(dep)
            continue
        tag = r"\(%s\)" % re.escape(dep)
        rng = ["--since", since] if since else []
        if git("log", tree.rev, *rng, "-E", "--format=%h", "--grep", tag).strip():
            continue
        hashes = git("log", "--all", *rng, "-E", "--format=%h", "--grep", tag).split()
        branches = sorted({b for h in hashes for b in git("branch", "-a", "--contains", h,
                                                        "--format=%(refname:short)").split()})
        add("WARN", "dep", "%s not on %s%s" % (dep, tree.rev, " (in %s)" % ", ".join(branches) if branches else
                                                " (no commit yet)"))
        unmerged.append(dep)

    # file: every path; FAIL only when the session is told to read it
    told = read_orders(text)
    t_spaced, t_reqs, t_plain = files_in(told)
    told_files = set(t_spaced + t_plain)
    spaced, reqs, plain = files_in(text)
    for f in sorted(set(spaced + plain)):
        if tree.find(f) or os.path.basename(f) in tgt:
            continue
        if f not in told_files:
            add("INFO", "file", "%s mentioned, not found at %s (not a read order)" % (f, tree.rev))
        elif unmerged:
            add("WARN", "file", "%s not at %s -- expected from %s (unmerged)" % (f, tree.rev, ", ".join(unmerged)))
        else:
            add("FAIL", "file", "%s told to read, NOT FOUND at %s" % (f, tree.rev))
    for r in sorted(set(reqs)):
        if req_text(r) is None:
            add("FAIL", "file", "%s NOT FOUND in %s" % (r, REQ_DIR))

    # req: US-x.y must be a heading in the named Requirement file (else any Requirement file)
    for line in told.splitlines():
        named = [x for x in REQ_FILE.findall(line) if req_text(x) is not None]
        pool = [req_text(x) for x in named] or [open(p, encoding="utf-8").read() for p in req_files()]
        for us in sorted(set(US_ID.findall(line))):
            rx = re.compile(r"^#{1,6}\s*US-%s\b" % re.escape(us), re.M)
            if not any(rx.search(s) for s in pool):
                add("FAIL", "req", "US-%s heading in no %s" % (us, named[0] if named else "Requirement file"))

    # anchor: quoted "## heading" in a doc the prompt names (else any Plan/ doc)
    docs = [h for f in t_plain + t_spaced if f.endswith(".md") for h in tree.find(f)]
    docs = docs or [f for f in tree.files if f.startswith("Plan/") and f.endswith(".md")]
    for h in sorted(set(QUOTED_HEAD.findall(told))):
        body = h.lstrip("#").strip()
        rx = re.compile(r"^#{1,6}\s*" + re.escape(body), re.M)
        if not any(rx.search(tree.show(d)) for d in docs) and \
                not any(rx.search(req_text(r) or "") for r in t_reqs):
            add("FAIL", "anchor", "heading \"%s\" in no named doc at %s" % (h, tree.rev))

    # sym: `file` `symbol` -- symbol present in that file; call-shaped token vs def arity
    seen = set()
    for f, tok, line in symbol_pairs(text):
        m = TS_IDENT.match(tok) if f.endswith(CODE_EXT) else CSS_TOKEN.match(tok) if f.endswith(".css") else None
        if not m or (f, tok) in seen:
            continue
        seen.add((f, tok))
        name = m.group(1)
        hits = tree.find(f)
        if not hits:
            continue  # file check owns this
        src = tree.show(hits[0])
        word = r"(?<![\w$-])%s(?![\w$-])" % re.escape(name)
        if not re.search(word, src):
            if os.path.basename(f) in tgt and NEW_WORD.search(line):
                continue  # this task writes it
            level = "WARN" if unmerged else "FAIL"
            add(level, "sym", "%s NOT FOUND in %s at %s%s" % (name, f, tree.rev,
                                                             " -- maybe from %s" % ", ".join(unmerged) if unmerged else ""))
            continue
        if f.endswith(CODE_EXT) and m.group(2) is not None:
            want = [a.strip() for a in m.group(2).split(",") if a.strip()]
            have = ts_def_params(src, name)
            if have is not None:
                lo, hi = params_range(have)
                if len(want) < lo or (hi is not None and len(want) > hi):
                    add("FAIL", "sym", "%s(%s) but %s has (%s)" % (name, ", ".join(want), f, have.strip()))

    for a in sorted(set(LINE_ANCHOR.findall(text))):
        add("WARN", "line", "%s -- line number drifts when file changes, anchor by symbol" % a)
    return out


def plan_since(plan):
    """Plan creation time -> ISO date; dep tags older than it belong to another plan (Plan/ is gitignored)."""
    st = os.stat(plan)
    born = getattr(st, "st_birthtime", None)
    return datetime.datetime.fromtimestamp(born).isoformat() if born else None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("plan")
    ap.add_argument("task", nargs="*")
    ap.add_argument("--rev", default="HEAD")
    ap.add_argument("--all", action="store_true", help="every task, not only ☐")
    ap.add_argument("-v", action="store_true", help="show INFO too")
    a = ap.parse_args()
    all_tasks = tasks(a.plan)
    ts = [t for t in all_tasks if t["id"].startswith("T")]
    if a.task:
        ts = [t for t in ts if t["id"] in a.task]
    elif not a.all:
        ts = [t for t in ts if t["status"] == "☐"]
    tree = Tree(a.rev)
    status = {t["id"]: t["status"] for t in all_tasks}
    since = plan_since(a.plan)
    fails = warns = 0
    for t in ts:
        if not t["code"].strip():
            continue  # done (block emptied)
        res = [r for r in check(t, tree, status, since) if a.v or r[0] != "INFO"]
        f = sum(r[0] == "FAIL" for r in res)
        w = sum(r[0] == "WARN" for r in res)
        fails += f
        warns += w
        print("%s %s: %s" % (t["status"], t["id"], "ok" if not res else "%d fail, %d warn" % (f, w)))
        for level, kind, msg in res:
            print("   %s %-7s %s" % (level, kind, msg))
    print("%d task(s), %d fail, %d warn (rev %s)" % (len(ts), fails, warns, a.rev))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
