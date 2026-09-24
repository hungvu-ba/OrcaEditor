#!/usr/bin/env python3
"""Context audit. Per unit of work: what the sessions read, what the final diff needed, what reading cost.

Source = Claude Code transcripts (~/.claude/projects/<slug>/*.jsonl) + git. No model self-report.
Rows are derived and rebuilt whole on every sweep. Ported from the PZMod repo (tools/context_audit.py).

  extract <session>    one session's intake as JSON (debug)
  sweep [--since D]    parse transcripts (cached by mtime), group into units, write log
  report [--since D]   markdown rollup of the log

Unit = one quick-dev spec (`spec/<slug>`: code session + review session + their commits), one
task-breakdown task without a spec (`task/T1.2`), one ad-hoc session with commits (`adhoc/<id8>`),
or one session without commits (`talk/<id8>`, cost only).

Session -> unit, strongest signal first:
  1. bmad-quick-dev(-solo) spec file named in the skill args, or the spec file the session edits
     most (`_bmad-output/quick-dev/{New,pending,inprogress,done}-<slug>.md`).
  2. First prompt line `T<phase>.<n> Code:` / `T<phase>.<n> Review:` (task-breakdown template).
Review phase starts at the first read of `bmad-quick-dev-solo/step-04-review.md` or the first
review skill call. Before it = code phase, after it = review phase (carry split code/review).

Golden (auto part): what the final diff needed -- edit sites (hunk pre-image), definitions of
repo functions the added lines call, imported repo modules, test files.

Status: provisional until a review phase ran or 48 h passed without a new commit.
Survival (rework proxy): share of added lines still on the integration branch 7 days after the last commit.

Log: ~/.claude/session-usage/<slug>/context-log.jsonl (+ context-sessions.json cache).

Examples:
  python3 scripts/context_audit.py sweep --since 2026-09-24
  python3 scripts/context_audit.py report --since 2026-09-24
  python3 scripts/context_audit.py extract e58808a1
"""
import argparse
import contextlib
import datetime as dt
import fcntl
import glob
import json
import os
import re
import shlex
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SLUG = ROOT.replace("/", "-").replace(" ", "-")
PROJECTS = os.path.expanduser("~/.claude/projects/" + SLUG)
STATE_DIR = os.path.expanduser("~/.claude/session-usage/" + SLUG)
LOG = os.path.join(STATE_DIR, "context-log.jsonl")
CACHE = os.path.join(STATE_DIR, "context-sessions.json")
REVIEW_LOG = os.path.join(ROOT, "Plan", "Skill Analysis", "review-log.jsonl")
SPEC_DIR = "_bmad-output/quick-dev"
PARSER_VERSION = 1  # bump -> cache dropped, every session reparsed

FINAL_AFTER = 48 * 3600
SURVIVAL_AFTER = 7 * 86400
CHARS_PER_TOKEN = 4  # rough, tool_result has no token count
CODE_EXT = (".ts", ".tsx", ".js", ".mjs", ".cjs", ".css", ".html")
FILE_RE = re.compile(r"[\w./-]+\.(?:ts|tsx|js|mjs|cjs|css|html|md|json|py|sh|yaml|yml|toml)\b")
TASK_HEAD_RE = re.compile(r"^\s*(T\d+\.\d+)\s+(Code|Review)\b")
SPEC_RE = re.compile(r"(?:New|pending|inprogress|done)-([\w.-]+?)\.md\b")
QUICK_DEV = ("bmad-quick-dev-solo", "bmad-quick-dev")
REVIEW_MARKER = "bmad-quick-dev-solo/step-04-review.md"
REVIEW_SKILLS = {"review-commit", "code-review", "review-changes", "bmad-review-adversarial-general", "bmad-review-edge-case-hunter"}
HASH_RE = re.compile(r"\b[0-9a-f]{7,40}\b")
COMMIT_OUT_RE = re.compile(r"^\[([^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\]", re.M)
REVIEW_ID_RE = re.compile(r"logged id=(\d+) (\S+) tier(\d) (\S+) found=(\d+) dropped=(\d+) fixed=(\d+) pending=(\d+)")
PASTE_TAG_RE = re.compile(r"^\s*</?pasted_content[^>]*>\s*$", re.M)
WORKTREE_RE = re.compile(r"^\.claude/worktrees/[^/]+/")
TEST_CMD_RE = re.compile(r"\b(?:npm\s+(?:run\s+)?(?:test|typecheck|lint|check:)[\w:-]*|npx\s+playwright\s+test|"
                         r"node\s+esbuild\.js|npx\s+tsc)\b")
READ_VERBS = {"cat", "head", "tail", "sed", "nl", "less", "awk", "bat"}
SEARCH_VERBS = {"grep", "rg", "find", "ls", "fd"}
GIT_PROBE = {"worktree", "branch", "log", "reflog", "status"}
INJECTED = ("<command-", "<local-command", "<bash-", "<system-reminder", "<ide_", "<task-notification", "Caveat:")


def integration_branch():
    for b in ("develop", "main"):
        if subprocess.run(["git", "-C", ROOT, "rev-parse", "--verify", "-q", b], capture_output=True).returncode == 0:
            return b
    return "HEAD"


# ---------- transcript ----------

def rows(path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue  # half-flushed last line, live session


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                out.append(b.get("text", ""))
            elif isinstance(b, str):
                out.append(b)
        return "\n".join(out)
    return ""


def is_real_user(row):
    if row.get("type") != "user" or row.get("isMeta"):
        return False
    c = (row.get("message") or {}).get("content")
    if isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
        return False
    t = text_of(c).lstrip()
    return bool(t) and not t.startswith(INJECTED)


def rel(path, cwd=ROOT):
    """Repo-relative path, worktree prefix stripped (worktree read = repo file). None = outside repo."""
    if not path:
        return None
    p = os.path.normpath(os.path.join(cwd, os.path.expanduser(path)))
    if not p.startswith(ROOT + os.sep):
        return None
    return WORKTREE_RE.sub("", os.path.relpath(p, ROOT))


def is_code(f):
    return bool(f) and f.endswith(CODE_EXT)


def line_count(relpath):
    try:
        with open(os.path.join(ROOT, relpath), encoding="utf-8", errors="replace") as fh:
            return sum(1 for _ in fh)
    except OSError:
        return None


def parse_prompt(text):
    """First prompt -> task id, role, planned file tokens."""
    text = PASTE_TAG_RE.sub("", text)  # pasted prompt wrapped in <pasted_content> tag lines
    first = text.strip().splitlines()[0] if text.strip() else ""
    task = role = None
    m = TASK_HEAD_RE.match(first)
    if m:
        task, role = m.group(1), m.group(2).lower()
    planned = sorted({os.path.basename(f) for f in FILE_RE.findall(text)})
    return {"task": task, "role": role, "planned": planned}


def split_segments(cmd):
    """Bash command -> list of argv segments. Heredoc body cut, cd tracked by caller."""
    cmd = cmd.split("<<", 1)[0]
    try:
        lex = shlex.shlex(cmd, posix=True, punctuation_chars=True)
        lex.whitespace_split = True
        toks = list(lex)
    except ValueError:
        return []
    segs, cur = [], []
    for t in toks:
        if t in ("&&", "||", ";", "|", "&", ";;", "\n"):
            if cur:
                segs.append(cur)
            cur = []
        else:
            cur.append(t)
    if cur:
        segs.append(cur)
    return segs


def sed_range(args):
    for a in args:
        m = re.fullmatch(r"(\d+)(?:,(\d+))?p", a.strip("'\""))
        if m:
            a1 = int(m.group(1))
            return [a1, int(m.group(2) or a1)]
    return None


def is_commit_cmd(cmd):
    """Real `git [-C x] commit` segment. Text "git commit" inside a script/heredoc = no."""
    for seg in split_segments(cmd):
        if os.path.basename(seg[0]) != "git":
            continue
        args = [a for i, a in enumerate(seg[1:]) if not (i and seg[i] in ("-C", "-c"))]
        if next((a for a in args if not a.startswith("-")), "") == "commit":
            return True
    return False


def commit_subject(cmd):
    """git commit -m "subj" | -m 'subj' | heredoc first line -> subject."""
    m = re.search(r"-m\s+\"\$\(cat <<'?(\w+)'?\n(.+?)\n", cmd) or re.search(r"-m\s+([\"'])(.+?)(?:\1|\n)", cmd)
    return m.group(2).strip() if m else None


def count_arg(args):
    """head/tail -n N | -N, default 10."""
    m = re.search(r"-n\s*(\d+)|-(\d+)\b", " ".join(args))
    return int(m.group(1) or m.group(2)) if m else 10


def bash_events(cmd, cwd):
    """Bash command -> read / search / edit / probe / tests events. Only existing repo files count as read."""
    out = []
    here = cwd
    if TEST_CMD_RE.search(cmd):
        out.append({"kind": "tests"})  # one run per call
    for seg in split_segments(cmd):
        verb = os.path.basename(seg[0])
        args = seg[1:]
        if verb == "cd" and args:
            here = os.path.normpath(os.path.join(here, os.path.expanduser(args[0])))
            continue
        if verb == "git" and args:
            rest = [a for i, a in enumerate(args) if not (i and args[i - 1] in ("-C", "-c"))]
            sub = next((a for a in rest if not a.startswith("-")), "")
            if sub in GIT_PROBE:
                out.append({"kind": "git_probe", "sub": sub})
            if sub in ("show", "diff", "log", "range-diff"):
                refs = [h for a in rest for h in HASH_RE.findall(a)]
                if refs:
                    out.append({"kind": "git_ref", "hashes": refs})
            if sub != "grep":
                continue
        # redirect / sed -i / tee = write
        for i, a in enumerate(seg):
            if a in (">", ">>") and i + 1 < len(seg):
                r = rel(seg[i + 1], here)
                if r:
                    out.append({"kind": "edit", "file": r, "via": "bash"})
        if verb == "sed" and any(a.startswith("-i") for a in args):
            for a in args:
                r = rel(a, here)
                if r and os.path.isfile(os.path.join(ROOT, r)):
                    out.append({"kind": "edit", "file": r, "via": "bash"})
            continue
        if verb == "tee":
            for a in args:
                r = rel(a, here) if not a.startswith("-") else None
                if r:
                    out.append({"kind": "edit", "file": r, "via": "bash"})
            continue
        files = []
        for a in args:
            if a.startswith("-"):
                continue
            r = rel(a, here)
            if r and os.path.isfile(os.path.join(ROOT, r)):
                files.append(r)
        if verb in READ_VERBS and files:
            rng = sed_range(args) if verb == "sed" else None
            for f in files:
                if verb == "head":
                    rng = [1, count_arg(args)]
                elif verb == "tail":
                    total = line_count(f) or count_arg(args)
                    rng = [max(total - count_arg(args) + 1, 1), total]
                out.append({"kind": "read", "file": f, "range": rng, "via": verb})
        elif verb in SEARCH_VERBS or (verb == "git" and args[:1] == ["grep"]):
            pat = next((a for a in args if not a.startswith("-") and a != "grep"), "")
            out.append({"kind": "search", "tool": verb, "pattern": pat[:80], "files": files})
    return out


def is_review_start(ev):
    """Raw tool event opens the review phase: step-04 read, or a review skill call."""
    if ev["tool"] == "Read":
        return (ev.get("file") or "").endswith(REVIEW_MARKER)
    return ev["tool"] in ("Skill", "Slash") and ev.get("skill") in REVIEW_SKILLS


def parse_session(path):
    """One transcript -> intake record. Main thread only for reads; subagents summed."""
    sid = os.path.basename(path)[:-6]
    first_prompt = None
    start = end = None
    cwd = ROOT
    api_ids, ctx = [], []
    tokens = {"output": 0, "cache_read": 0, "cache_create": 0, "input": 0}
    compactions = user_turns = 0
    pending = {}  # tool_use_id -> event
    events = []
    extra = []  # (api, call, chars, bucket): model output + injected text, not tool result
    outs = []  # output tokens per api call

    for r in rows(path):
        ts = r.get("timestamp")
        if ts:
            start = start or ts
            end = ts
        if r.get("cwd"):
            cwd = r["cwd"]
        if r.get("type") == "attachment" and api_ids:  # edited file, hook text, reminder
            extra.append((len(api_ids), len(events), len(json.dumps(r.get("attachment"))), "injected"))
        if r.get("isCompactSummary") or (r.get("type") == "system" and r.get("subtype") == "compact_boundary"):
            compactions += 1
        msg = r.get("message") or {}
        content = msg.get("content")

        if r.get("type") == "user":
            t = text_of(content)
            if "<command-name>" in t:  # slash command = skill run, args may name the spec
                name = t.split("<command-name>", 1)[1].split("</command-name>", 1)[0].strip().lstrip("/")
                args = t.split("<command-args>", 1)[1].split("</command-args>", 1)[0] if "<command-args>" in t else ""
                events.append({"call": len(events), "api": len(api_ids), "tool": "Slash", "skill": name,
                               "args": args[:500]})
            if is_real_user(r):
                user_turns += 1
                if first_prompt is None:
                    first_prompt = text_of(content)
            if api_ids and t:  # before 1st call = inside ctx_first
                extra.append((len(api_ids), len(events), len(t), "user" if is_real_user(r) else "injected"))
            if isinstance(content, list):
                for b in content:
                    if not (isinstance(b, dict) and b.get("type") == "tool_result"):
                        continue
                    ev = pending.pop(b.get("tool_use_id"), None)
                    if ev is None:
                        continue
                    res = b.get("content")
                    txt = res if isinstance(res, str) else text_of(res)
                    ev["chars"] = len(txt)
                    ev["error"] = bool(b.get("is_error"))
                    tur = r.get("toolUseResult")
                    if ev["tool"] == "Read" and isinstance(tur, dict) and isinstance(tur.get("file"), dict):
                        f = tur["file"]
                        if f.get("startLine") and f.get("numLines") is not None:
                            ev["range"] = [f["startLine"], f["startLine"] + max(f["numLines"], 1) - 1]
                    if ev["tool"] == "Bash":
                        # [branch hash] only when own commit ran -- other output lists foreign hashes
                        ev["commits"] = [h for _, h in COMMIT_OUT_RE.findall(txt)] if ev.get("is_commit") else []
                        ev["review_ids"] = [dict(zip(("id", "tool", "tier", "scope", "found", "dropped", "fixed",
                                                      "pending"), m)) for m in REVIEW_ID_RE.findall(txt)]
                        if any(s["kind"] == "tests" for s in ev["sub"]):
                            ev["tests_pass"] = not ev["error"]  # non-zero exit = is_error
                        ev["out_lines"] = txt.count("\n") + 1 if txt else 0
                    if ev["tool"] in ("Grep", "Glob"):
                        ev["out_lines"] = txt.count("\n") + 1 if txt else 0
            continue

        if r.get("type") != "assistant":
            continue
        mid = msg.get("id")
        usage = msg.get("usage")
        if mid and usage and mid not in api_ids and msg.get("model") != "<synthetic>":
            api_ids.append(mid)
            size = (usage.get("input_tokens") or 0) + (usage.get("cache_read_input_tokens") or 0) \
                + (usage.get("cache_creation_input_tokens") or 0)
            ctx.append(size)
            tokens["output"] += usage.get("output_tokens") or 0
            tokens["cache_read"] += usage.get("cache_read_input_tokens") or 0
            tokens["cache_create"] += usage.get("cache_creation_input_tokens") or 0
            tokens["input"] += usage.get("input_tokens") or 0
            outs.append(usage.get("output_tokens") or 0)  # thinking included, stays in context
            extra.append((len(api_ids), len(events), 0, "model_out"))
        if not isinstance(content, list):
            continue
        for b in content:
            if not (isinstance(b, dict) and b.get("type") == "tool_use"):
                continue
            name, inp = b.get("name"), b.get("input") or {}
            ev = {"call": len(events), "api": len(api_ids), "tool": name}
            if name == "Read":
                ev["file"] = rel(inp.get("file_path"), cwd) or inp.get("file_path")
                ev["repo"] = rel(inp.get("file_path"), cwd) is not None
                off, lim = inp.get("offset"), inp.get("limit")
                ev["range"] = [off or 1, (off or 1) + lim - 1] if lim else None
            elif name in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
                ev["file"] = rel(inp.get("file_path") or inp.get("notebook_path"), cwd)
            elif name == "Bash":
                ev["cmd"] = (inp.get("command") or "")[:300]
                ev["is_commit"] = is_commit_cmd(inp.get("command") or "")
                ev["subject"] = commit_subject(inp.get("command") or "") if ev["is_commit"] else None
                ev["ts"] = ts
                ev["sub"] = bash_events(inp.get("command") or "", cwd)
            elif name in ("Grep", "Glob"):
                ev["pattern"] = (inp.get("pattern") or "")[:80]
            elif name == "Skill":
                ev["skill"] = inp.get("skill")
                ev["args"] = (inp.get("args") or "")[:500]
            elif name in ("Agent", "Task"):
                ev["agent"] = inp.get("subagent_type") or "general-purpose"
            events.append(ev)
            if b.get("id"):
                pending[b["id"]] = ev

    subs = {"sessions": 0, "cache_read": 0, "output": 0}
    for sp in glob.glob(path[:-6] + "/subagents/agent-*.jsonl"):
        subs["sessions"] += 1
        seen = set()
        for r in rows(sp):
            msg = r.get("message") or {}
            u = msg.get("usage")
            if r.get("type") == "assistant" and u and msg.get("id") not in seen:
                seen.add(msg.get("id"))
                subs["cache_read"] += u.get("cache_read_input_tokens") or 0
                subs["output"] += u.get("output_tokens") or 0

    prompt = parse_prompt(first_prompt or "")
    return {
        "id": sid, "start": start, "end": end, "user_turns": user_turns,
        "prompt_head": (first_prompt or "").strip()[:160], "prompt": (first_prompt or "")[:6000], **prompt,
        "spec": spec_of(events),
        "api_calls": len(api_ids), "ctx_first": ctx[0] if ctx else 0, "ctx_peak": max(ctx) if ctx else 0,
        "tokens": tokens, "compactions": compactions, "subagents": subs,
        "carry": carry_split(events, extra, ctx, outs),
        "events": flatten(events, len(api_ids)),
    }


def spec_of(events):
    """Own quick-dev spec slug: named in the skill args, else the spec file edited most.
    Reads alone never count -- step-03's lock scan reads every other in-progress spec."""
    for e in events:
        if e["tool"] in ("Skill", "Slash") and e.get("skill") in QUICK_DEV:
            m = SPEC_RE.search(e.get("args") or "")
            if m:
                return m.group(1)
    counts = {}
    for e in events:
        f = e.get("file") or ""
        if e["tool"] in ("Edit", "Write", "MultiEdit") and f.startswith(SPEC_DIR + "/"):
            m = SPEC_RE.search(os.path.basename(f))
            if m:
                counts[m.group(1)] = counts.get(m.group(1), 0) + 1
    return max(counts, key=counts.get) if counts else None


def carry_bucket(ev):
    t = ev["tool"]
    if t == "Read":
        return "read"
    if t in ("Grep", "Glob"):
        return "search"
    if t in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        return "edit"
    if t in ("Skill", "Slash"):
        return "skill"
    if t in ("Agent", "Task"):
        return "subagent"
    if t.startswith("mcp__code-review-graph"):
        return "graph"
    if t != "Bash":
        return "other_tool"
    cmd, kinds = ev.get("cmd") or "", {x["kind"] for x in ev.get("sub", [])}
    if "tests" in kinds:
        return "tests"
    if cmd.lstrip().startswith("git") or kinds & {"git_probe", "git_ref"}:
        return "git"
    if "search" in kinds:
        return "search"
    if "read" in kinds:
        return "read"
    return "bash_other"


def carry_split(events, extra, ctx, outs):
    """Context re-read per source, token x api calls after. pre/post = before/after review start.
    Tokens from real growth: ctx[a] - ctx[a-1] = model output of call a (thinking too) + items after it,
    rest split by chars. residual = growth with no item seen."""
    total = len(ctx)
    rv = next((e["call"] for e in events if is_review_start(e)), None)
    cut = events[rv]["api"] if rv is not None else total
    side = {"pre": {"baseline": ctx[0] * cut if ctx else 0, "ctx_sum": sum(ctx[:cut])},
            "post": {"baseline": ctx[0] * (total - cut) if ctx else 0, "ctx_sum": sum(ctx[cut:])}}
    by = {}
    for it in [(e["api"], e["call"], e.get("chars", 0), carry_bucket(e)) for e in events if e.get("chars")] + extra:
        by.setdefault(it[0], []).append(it)

    def add(api, call, b, tok):
        pre_n, post_n = max(cut - api, 0), total - max(api, cut)  # calls re-reading it, per side
        if rv is not None and call >= rv:
            side["post"][b] = side["post"].get(b, 0) + tok * post_n
        else:
            side["pre"][b] = side["pre"].get(b, 0) + tok * pre_n
            if post_n:  # code-phase context the review phase still hauls
                side["post"]["code_context"] = side["post"].get("code_context", 0) + tok * post_n

    for a in range(1, total):
        grow = ctx[a] - ctx[a - 1]
        if grow <= 0:  # compaction
            continue
        items = by.get(a, [])
        model = next((i for i in items if i[3] == "model_out"), None)
        mtok = min(outs[a - 1], grow)
        if model:
            add(a, model[1], "model_out", mtok)
        rest, w = grow - mtok, sum(i[2] for i in items if i[3] != "model_out")
        if not w:
            add(a, model[1] if model else 0, "residual", rest)
            continue
        shares = [i for i in items if i[3] != "model_out" and i[2]]
        left = rest
        for n, (api, call, chars, b) in enumerate(shares):
            tok = left if n == len(shares) - 1 else rest * chars // w  # last takes the rounding rest
            left -= tok
            add(a, call, b, tok)
    return side


def flatten(events, api_total):
    """Tool calls -> intake list: read / search / edit / friction, with carry cost."""
    out = []
    for ev in events:
        left = max(api_total - ev["api"], 0)  # api calls that re-read this result
        tok = ev.get("chars", 0) // CHARS_PER_TOKEN
        base = {"call": ev["call"], "api": ev["api"], "tok": tok, "carry": tok * left}
        t = ev["tool"]
        if t == "Read":
            out.append({**base, "kind": "read", "file": ev["file"], "repo": ev["repo"],
                        "range": ev.get("range"), "via": "Read"})
        elif t in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
            out.append({**base, "kind": "edit", "file": ev["file"], "via": t, "fail": ev.get("error", False)})
        elif t in ("Grep", "Glob"):
            out.append({**base, "kind": "search", "tool": t, "pattern": ev["pattern"], "hits": ev.get("out_lines", 0)})
        elif t in ("Skill", "Slash"):
            out.append({**base, "kind": "skill", "name": ev.get("skill"), "args": ev.get("args", "")})
        elif t in ("Agent", "Task"):
            out.append({**base, "kind": "subagent", "agent": ev.get("agent")})
        elif t == "AskUserQuestion":
            out.append({**base, "kind": "ask_user"})
        elif t == "Bash":
            subs = ev.get("sub", [])
            reads = [s for s in subs if s["kind"] == "read"]
            share = tok // max(len(reads), 1)
            for s in subs:
                e = {**base, **s}
                if s["kind"] == "read":
                    e.update(tok=share, carry=share * left, repo=True)
                elif s["kind"] == "search":
                    e["hits"] = ev.get("out_lines", 0)
                elif s["kind"] == "tests":
                    e["pass"] = ev.get("tests_pass")
                out.append(e)
            if not subs:
                out.append({**base, "kind": "bash"})
            for h in ev.get("commits", []):
                out.append({"call": ev["call"], "kind": "commit", "hash": h})
            if ev.get("subject") and not ev.get("error"):
                out.append({"call": ev["call"], "kind": "commit_msg", "subject": ev["subject"], "ts": ev.get("ts")})
            for sig in ev.get("review_ids", []):
                out.append({"call": ev["call"], "kind": "review_log", "id": int(sig["id"]), "sig": sig,
                            "ts": ev.get("ts")})
        if is_review_start(ev):
            out.append({"call": ev["call"], "kind": "review_start"})
    return out


# ---------- cache ----------

def load_cache():
    try:
        with open(CACHE) as fh:
            c = json.load(fh)
        return c if c.get("version") == PARSER_VERSION else {"version": PARSER_VERSION, "sessions": {}}
    except (OSError, ValueError):
        return {"version": PARSER_VERSION, "sessions": {}}


def sessions_since(since):
    cache = load_cache()
    out, dirty = [], False
    # worktree session = own transcript dir <slug>--claude-worktrees-<name>
    for p in glob.glob(os.path.join(PROJECTS, "*.jsonl")) + glob.glob(PROJECTS + "--claude-worktrees-*/*.jsonl"):
        st = os.stat(p)
        sid = os.path.basename(p)[:-6]
        hit = cache["sessions"].get(sid)
        if hit and hit["mtime"] == st.st_mtime and hit["size"] == st.st_size:
            s = hit["data"]
        else:
            s = parse_session(p)
            cache["sessions"][sid] = {"mtime": st.st_mtime, "size": st.st_size, "data": s}
            dirty = True
        if s["start"] and s["start"][:10] >= since:
            out.append(s)
    if dirty:
        os.makedirs(STATE_DIR, exist_ok=True)
        tmp = "%s.%d.tmp" % (CACHE, os.getpid())  # hook sweeps may overlap
        with open(tmp, "w") as fh:
            json.dump(cache, fh)
        os.replace(tmp, CACHE)
    return sorted(out, key=lambda s: s["start"] or "")


# ---------- git ----------

def git(*args):
    r = subprocess.run(["git", "-C", ROOT, *args], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else ""


def commit_info(h):
    head = git("show", "-s", "--format=%H%x09%ct%x09%s", h).strip()
    if not head:
        return None
    full, ct, subj = head.split("\t", 2)
    files = {}
    cur, new_file = None, False
    for line in git("show", "-U0", "--format=", "--no-renames", "--first-parent", full).splitlines():
        if line.startswith("--- "):
            new_file = line[4:].rstrip("\t") == "/dev/null"
        elif line.startswith("+++ "):
            cur = None if line[4:] == "/dev/null" else line[6:].rstrip("\t")  # delete -> no site; tab after a path with spaces
            if cur:
                files.setdefault(cur, {"old": [], "added": [], "new_file": new_file})
        elif line.startswith("@@") and cur:
            m = re.match(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", line)
            if m:
                o, oc = int(m.group(1)), int(m.group(2) or 1)
                files[cur]["old"].append([max(o, 1), max(o + oc - 1, o, 1)])  # oc 0 = insert after line o
        elif line.startswith("+") and cur:
            files[cur]["added"].append(line[1:])
    return {"hash": full[:10], "time": int(ct), "subject": subj, "files": files}


def survival(info_list, last_time):
    """Share of the unit's added lines (alive at its last commit) still on the integration branch
    7 days later. Content match, not blame -- rebase changes hashes. File absent there = unmerged, skip."""
    if time.time() - last_time < SURVIVAL_AFTER:
        return None
    rev = git("rev-list", "-1", "--before=%d" % (last_time + SURVIVAL_AFTER), integration_branch()).strip()
    if not rev:
        return None
    last = info_list[-1]["hash"]
    kept = total = 0
    for f, lines in added_by_file(info_list).items():
        then = {l.strip() for l in git("show", "%s:%s" % (last, f)).splitlines()}
        body = git("show", "%s:%s" % (rev, f))
        if not body:
            continue
        have = {l.strip() for l in body.splitlines()}
        for l in dict.fromkeys(x.strip() for x in lines):
            if len(l) > 3 and l in then:  # dropped by a later in-unit commit = not rework
                total += 1
                kept += l in have
    return round(kept / total, 3) if total else None


def added_by_file(info_list):
    out = {}
    for c in info_list:
        for f, d in c["files"].items():
            out.setdefault(f, []).extend(d["added"])
    return out


# ---------- golden (auto part) ----------

DEF_RE = re.compile(
    r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*[<(]"
    r"|^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|\w+\s*=>)"
    r"|^\s+(?:(?:public|private|protected|static|async|override|readonly)\s+)*(\w+)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$")
CALL_RE = re.compile(r"(?<![\w.])(\w+)\s*\(|\.(\w+)\s*\(")
IMPORT_RE = re.compile(r"(?:from|import)\s*\(?\s*['\"](\.{1,2}/[^'\"]+)['\"]")
KEYWORDS = {"if", "for", "while", "switch", "catch", "return", "function", "typeof", "new", "super", "await",
            "constructor", "get", "set"}
SCAN_DIRS = ("src", "media", "test", "scripts")
_def_index = None


def def_index():
    """name -> [(file, start, end, name)] over repo TS/JS sources."""
    global _def_index
    if _def_index is not None:
        return _def_index
    idx = {}
    for d in SCAN_DIRS:
        for p in glob.glob(os.path.join(ROOT, d, "**", "*"), recursive=True):
            if not p.endswith((".ts", ".tsx", ".js", ".mjs")) or "/node_modules/" in p or p.endswith(".d.ts"):
                continue
            r = os.path.relpath(p, ROOT)
            try:
                lines = open(p, encoding="utf-8", errors="replace").read().splitlines()
            except OSError:
                continue
            for i, line in enumerate(lines):
                m = DEF_RE.match(line)
                if not m:
                    continue
                name = m.group(1) or m.group(2) or m.group(3)
                if name in KEYWORDS:
                    continue
                indent = len(line) - len(line.lstrip())
                end = min(i + 60, len(lines))
                for j in range(i + 1, min(i + 200, len(lines))):
                    s = lines[j]
                    if s.strip().startswith("}") and len(s) - len(s.lstrip()) <= indent:
                        end = j + 1
                        break
                idx.setdefault(name, []).append((r, i + 1, end, name))
    _def_index = idx
    return idx


def resolve_import(src_file, spec):
    base = os.path.normpath(os.path.join(os.path.dirname(src_file), spec))
    for cand in (base, base + ".ts", base + ".tsx", base + ".js", os.path.join(base, "index.ts")):
        if os.path.isfile(os.path.join(ROOT, cand)):
            return cand
    return None


def golden_auto(info_list):
    """Final diff -> golden items: site (hunk pre-image), def (called repo function), module, test."""
    items, own_defs = [], set()
    for c in info_list:
        for f, d in c["files"].items():
            for l in d["added"]:
                m = DEF_RE.match(l)
                if m:
                    own_defs.add(m.group(1) or m.group(2) or m.group(3))
    seen = set()
    idx = def_index()
    for c in info_list:
        for f, d in c["files"].items():
            kind = "test" if f.startswith("test/") else "site"
            if d["new_file"] and kind == "site":
                continue  # new file, nothing to read before
            for o in d["old"] or [[1, 1]]:
                key = (kind, f, o[0])
                if key not in seen:
                    seen.add(key)
                    items.append({"kind": kind, "file": f, "range": [max(o[0] - 5, 1), o[1] + 5], "ref": f})
            if not f.endswith((".ts", ".tsx", ".js", ".mjs")):
                continue
            for l in d["added"]:
                if l.strip().startswith(("//", "*", "/*")):
                    continue
                for m in IMPORT_RE.finditer(l):
                    hit = resolve_import(f, m.group(1))
                    if hit and ("module", hit) not in seen:
                        seen.add(("module", hit))
                        items.append({"kind": "module", "ref": m.group(1), "file": hit, "range": None})
                for m in CALL_RE.finditer(l):
                    name = m.group(1) or m.group(2)
                    if name in KEYWORDS or name in own_defs or ("def", name) in seen:
                        continue
                    seen.add(("def", name))
                    cands = idx.get(name, [])
                    if 0 < len(cands) <= 3:  # unknown = platform/DOM/library; many = too generic to pin
                        for fr, a, b, _ in cands:
                            items.append({"kind": "def", "ref": name, "file": fr, "range": [a, b]})
    return items


def overlap(a, b):
    """Lines shared by two [start, end] ranges; None range = whole file."""
    if a is None or b is None:
        return None
    lo, hi = max(a[0], b[0]), min(a[1], b[1])
    return max(hi - lo + 1, 0)


# ---------- unit ----------

def classify(reads, edits, planned):
    """Each read -> planned | forced | discovery | outside, + reread flag."""
    seen = {}
    for r in reads:
        f = r["file"]
        if not r.get("repo") or not f:
            r["class"] = "outside"
        elif os.path.basename(f) in planned:
            r["class"] = "planned"
        elif any(e["file"] == f and e["call"] > r["call"] for e in edits):
            r["class"] = "forced"
        else:
            r["class"] = "discovery"
        prev = seen.setdefault(f, [])
        r["reread"] = any(p is None or r.get("range") is None or overlap(p, r["range"]) for p in prev)
        prev.append(r.get("range"))


def read_lines(r):
    rng = r.get("range")
    if rng:
        return rng[1] - rng[0] + 1
    n = line_count(r["file"]) if r.get("repo") else None
    return n or r.get("tok", 0) // 10  # ~10 token/line fallback


def spec_planned(slug):
    """Files the spec names (Code Map, targets, tasks) -- the plan a quick-dev code session works from."""
    for p in glob.glob(os.path.join(ROOT, SPEC_DIR, "**", "*-%s.md" % slug), recursive=True):
        if SPEC_RE.search(os.path.basename(p)):
            try:
                return {os.path.basename(f) for f in FILE_RE.findall(open(p, encoding="utf-8").read())}
            except OSError:
                pass
    return set()


def build_unit(key, kind, sessions, hashes, review_log):
    infos = list({i["hash"]: i for i in (commit_info(h) for h in dict.fromkeys(hashes)) if i}.values())
    infos.sort(key=lambda c: c["time"])
    code_s = [s for s in sessions if s.get("role") != "review"]
    rv = {"reads": 0, "lines": 0, "carry": 0}  # review-phase intake, kept apart from task context
    planned = set()
    for s in code_s:
        planned.update(s["planned"])
    slug = next((s["spec"] for s in sessions if s.get("spec")), None)
    if slug:
        planned |= spec_planned(slug)

    reads, edits, searches = [], [], []
    fr = {"edit_fail": 0, "ask_user": 0, "git_probe": 0, "tests_runs": 0, "tests_fail": 0, "user_turns": 0,
          "compactions": 0, "subagents": 0}
    review_ids = []
    for s in sessions:
        fr["compactions"] += s["compactions"]
        if s in code_s:
            fr["user_turns"] += max(s["user_turns"] - 1, 0)  # turn beyond prompt = steering
        split = s.get("review_at") if s.get("role") == "mixed" else None
        for e in s["events"]:
            e = dict(e, session=s["id"][:8], role=s.get("role") or "adhoc")
            k = e["kind"]
            if k == "review_log" and e.get("resolved"):
                review_ids.append(e["resolved"])
            if s not in code_s or (split is not None and e["call"] >= split):
                if k == "read":  # review intake = review cost, not task context
                    rv["reads"] += 1
                    rv["lines"] += read_lines(e)
                    rv["carry"] += e.get("carry", 0)
                continue
            if k == "read":
                reads.append(e)
            elif k == "edit":
                edits.append(e)
                fr["edit_fail"] += bool(e.get("fail"))
            elif k == "search":
                searches.append(e)
            elif k == "ask_user":
                fr["ask_user"] += 1
            elif k == "git_probe":
                fr["git_probe"] += 1
            elif k == "subagent":
                fr["subagents"] += 1
            elif k == "tests":
                fr["tests_runs"] += 1
                fr["tests_fail"] += e.get("pass") is False
    classify(reads, edits, planned)

    gold = golden_auto(infos) if infos else []
    useful = total = doc_lines = 0
    for r in reads:
        n = read_lines(r)
        r["lines"] = n
        if r["class"] == "outside":
            continue
        if not is_code(r["file"]):
            doc_lines += n  # doc usefulness is not scored automatically
            continue
        total += n
        rng = r.get("range") or [1, n]
        best = 0
        for g in gold:
            if g.get("file") != r["file"]:
                continue
            best += overlap(rng, g["range"] or [1, min(n, 30)]) or 0
        r["useful"] = min(best, n)
        r["golden"] = best > 0
        useful += r["useful"]
    prompt_text = "\n".join(s.get("prompt", "") for s in code_s)
    for g in gold:
        by_file = bool(g.get("file")) and os.path.basename(g["file"]) in planned
        g["in_prompt"] = by_file or g["ref"] in prompt_text
        hit = [r for r in reads if r.get("file") == g.get("file")
               and (g["range"] is None or r.get("range") is None or overlap(r["range"], g["range"]))]
        g["read_at"] = hit[0]["call"] if hit else None
    gold_files = {g["file"] for g in gold if g.get("file")} | {e["file"] for e in edits if e.get("file")}
    unused = sorted(p for p in planned if p.endswith(CODE_EXT)
                    and not any(os.path.basename(f) == p for f in gold_files))

    last = infos[-1]["time"] if infos else None
    reviewed = bool(review_ids) or any(s.get("role") in ("review", "mixed") for s in sessions)
    if not infos:
        status = "cost-only"
    elif reviewed or time.time() - last > FINAL_AFTER:
        status = "final"
    else:
        status = "provisional"

    reviews = [review_log[i] for i in review_ids if i in review_log]
    split_c = {"code": {}, "review": {}}
    for s in sessions:
        for half, d in (s.get("carry") or {}).items():
            to = "review" if s not in code_s or (half == "post" and s.get("role") == "mixed") else "code"
            for b, v in d.items():
                split_c[to][b] = split_c[to].get(b, 0) + v
    carry = sorted((r for r in reads if r["class"] != "outside"), key=lambda r: -r["carry"])[:3]
    added = sum(len(d["added"]) for c in infos for d in c["files"].values())
    return {
        "unit": key, "kind": kind, "status": status, "spec": slug,
        "task": next((s["task"] for s in sessions if s.get("task")), None),
        "start": sessions[0]["start"] if sessions else None,
        "sessions": [{"id": s["id"][:8], "role": s.get("role") or "adhoc", "join": s.get("join"),
                      "review_at": s.get("review_at"), "turns": s["user_turns"],
                      "api_calls": s["api_calls"], "ctx_first": s["ctx_first"], "ctx_peak": s["ctx_peak"],
                      "cache_read": s["tokens"]["cache_read"], "output": s["tokens"]["output"],
                      "subagents": s["subagents"]["sessions"], "subagent_cache_read": s["subagents"]["cache_read"]}
                     for s in sessions],
        "diff": {"commits": [c["hash"] for c in infos], "files": len({f for c in infos for f in c["files"]}),
                 "added": added, "last": last},
        "planned": sorted(planned),
        "prompt": "\n---\n".join(s.get("prompt", "") for s in code_s)[:6000],
        "reads": [{k: r.get(k) for k in ("call", "session", "file", "range", "via", "class", "reread",
                                          "lines", "tok", "carry", "useful", "golden")} for r in reads],
        "searches": [{k: s.get(k) for k in ("call", "tool", "pattern", "hits")} for s in searches],
        "friction": fr,
        "review_intake": rv,
        "carry_split": split_c,
        "golden": gold,
        "metrics": {
            "read_lines_code": total, "read_lines_doc": doc_lines,
            "precision": round(useful / total, 3) if total else None,
            "golden": sum(1 for g in gold if g.get("file")),
            "golden_in_prompt": sum(1 for g in gold if g.get("file") and g["in_prompt"]),
            "discovery": sum(1 for r in reads if r["class"] == "discovery" and r.get("golden")),
            "discovery_reads": sum(1 for r in reads if r["class"] == "discovery"),
            "rereads": sum(1 for r in reads if r["reread"]),
            "unused_planned": unused,
            "carry_total": sum(r["carry"] for r in reads),
            "carry_top": [{"file": r["file"], "call": r["call"], "carry": r["carry"]} for r in carry],
        },
        "outcome": {
            "has_review": reviewed, "review_ids": review_ids,
            "review_tier": max((r.get("tier") or 0 for r in reviews), default=None),
            "tests_first_pass": None if not fr["tests_runs"] else fr["tests_fail"] == 0,
            "review_found": sum(r.get("dedup") or r.get("found") or 0 for r in reviews),
            "review_bugs": sum(len(r.get("bugs") or []) for r in reviews),
            "survival": survival(infos, last) if infos else None,
        },
    }


def load_review_log():
    out = {}
    try:
        with open(REVIEW_LOG) as fh:
            for line in fh:
                if line.strip():
                    e = json.loads(line)
                    out[e["id"]] = e
    except OSError:
        pass
    return out


def join(s):
    """Session -> (key, via, role, review_at). Spec slug beats task id: a task-breakdown task run through
    quick-dev has both, and its review session (handoff prompt) carries only the spec."""
    ev = s["events"]
    review_at = next((e["call"] for e in ev if e["kind"] == "review_start"), None)
    if review_at is None and s.get("role") == "review":
        review_at = 0  # `T1.2 Review:` prompt = review from the first call
    coded = any(e["kind"] == "edit" and is_code(e.get("file")) and (review_at is None or e["call"] < review_at)
                for e in ev)
    role = "code" if review_at is None else "mixed" if coded else "review"
    if s.get("spec"):
        return "spec/" + s["spec"], "spec", role, review_at
    if s.get("task"):
        return "task/" + s["task"], "prompt", role, review_at
    return None, None, role, review_at


def subject_map(since):
    """subject -> [(hash, time)] for every commit since window start (all branches)."""
    out = {}
    start = (dt.date.fromisoformat(since) - dt.timedelta(days=2)).isoformat()
    for line in git("log", "--all", "--since=" + start, "--format=%H%x09%ct%x09%s").splitlines():
        h, ct, subj = line.split("\t", 2)
        out.setdefault(subj.strip(), []).append((h[:10], int(ct)))
    return out


def session_commits(s, smap):
    """Own commits: printed [branch hash] + -m subject resolved to the nearest commit in time."""
    out = [e["hash"] for e in s["events"] if e["kind"] == "commit"]
    for e in s["events"]:
        if e["kind"] != "commit_msg" or e["subject"] not in smap:
            continue
        at = dt.datetime.fromisoformat(e["ts"].replace("Z", "+00:00")).timestamp() if e.get("ts") else 0
        h, ct = min(smap[e["subject"]], key=lambda x: abs(x[1] - at))
        if abs(ct - at) < 6 * 3600 and not any(x.startswith(h[:7]) or h.startswith(x[:7]) for x in out):
            out.append(h)  # amend/rebase later -> nearest same subject
    return out


def resolve_review(e, review_log):
    """Logged line -> review-log id. Same id + same numbers = it; else same numbers + same day."""
    sig = e.get("sig")

    def same(r):
        return all(str(r.get(k)) == sig[k] for k in ("tool", "scope", "found", "dropped", "fixed", "pending")) \
            and str(r.get("tier")) == sig["tier"]
    r = review_log.get(e["id"])
    if r and same(r):
        return e["id"]
    day = (e.get("ts") or "")[:10]
    hits = [i for i, r in review_log.items() if same(r) and day and abs(
        (dt.date.fromisoformat(r["ts"][:10]) - dt.date.fromisoformat(day)).days) <= 1]
    return hits[0] if len(hits) == 1 else None


def sweep(since):
    sessions = sessions_since(since)
    review_log = load_review_log()
    smap = subject_map(since)
    groups, rest = {}, []
    for s in sessions:
        s["commits"] = session_commits(s, smap)
        for e in s["events"]:
            if e["kind"] == "review_log":
                e["resolved"] = resolve_review(e, review_log)
        key, via, role, review_at = join(s)
        s.update(role=role, join=via, review_at=review_at)
        if key:
            groups.setdefault(key, []).append(s)
        else:
            rest.append(s)
    units = []
    for key, ss in sorted(groups.items()):
        units.append(build_unit(key, key.split("/", 1)[0], ss, [h for s in ss for h in s["commits"]], review_log))
    for s in rest:
        kind = "adhoc" if s["commits"] else "talk"
        units.append(build_unit("%s/%s" % (kind, s["id"][:8]), kind, [s], s["commits"], review_log))

    with log_lock():  # another session's hook may write the same file
        write_units(merge_old(units, since))
    return units


@contextlib.contextmanager
def log_lock():
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(LOG + ".lock", "w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def read_units():
    if not os.path.exists(LOG):
        return []
    with open(LOG) as fh:
        return [json.loads(l) for l in fh if l.strip()]


def write_units(units):
    """Caller holds log_lock. Temp per pid, atomic replace."""
    tmp = "%s.%d.tmp" % (LOG, os.getpid())
    with open(tmp, "w") as fh:
        for u in sorted(units, key=lambda u: u.get("start") or ""):
            fh.write(json.dumps(u, ensure_ascii=False) + "\n")
    os.replace(tmp, LOG)


def merge_old(units, since):
    """Fresh rows + rows before the window untouched."""
    fresh = {u["unit"] for u in units}
    keep = [u for u in read_units() if u["unit"] not in fresh and (u.get("start") or "")[:10] < since]
    return keep + units


# ---------- report ----------

def k(n):
    return "%.0fk" % (n / 1000) if n >= 1000 else str(n)


def pct(x):
    return "-" if x is None else "%d%%" % round(x * 100)


CARRY_ORDER = ("baseline", "read", "search", "graph", "tests", "git", "bash_other", "edit", "skill", "subagent",
               "other_tool", "model_out", "injected", "user", "code_context", "residual")


def carry_table(units):
    """Where context re-read goes: token x api calls after, code vs review phase."""
    if not units:
        return []
    tot = {"code": {}, "review": {}}
    for u in units:
        for ph in tot:
            for b, v in u["carry_split"][ph].items():
                tot[ph][b] = tot[ph].get(b, 0) + v
    base = {ph: max(d.get("ctx_sum", 0), 1) for ph, d in tot.items()}
    out = ["## Context carry by source (token x api calls after, %d units)" % len(units), "",
           "Sum of context re-read per call. baseline = first-call context x calls; model_out = own output "
           "incl thinking; code_context = code-phase context the review phase hauls; residual = growth with no "
           "item seen.", "", "| Source | Code | Code % | Review | Review % |", "|---|--:|--:|--:|--:|"]
    for b in CARRY_ORDER:
        c, r = tot["code"].get(b, 0), tot["review"].get(b, 0)
        if c or r:
            out.append("| %s | %s | %s | %s | %s |" % (b, k(c), pct(c / base["code"]), k(r), pct(r / base["review"])))
    out += ["| **ctx sum** | %s | | %s | |" % (k(tot["code"].get("ctx_sum", 0)), k(tot["review"].get("ctx_sum", 0))), ""]
    return out


def report(since):
    units = [u for u in read_units() if (u.get("start") or "")[:10] >= since]
    out = ["# Context audit since %s" % since, ""]
    by = {}
    for u in units:
        by.setdefault(u["kind"], []).append(u)
    out.append("Units: " + (", ".join("%s %d" % (kk, len(v)) for kk, v in sorted(by.items())) or "none") + "  ")
    out.append("Status: " + ", ".join("%s %d" % (st, sum(u["status"] == st for u in units))
                                      for st in ("final", "provisional", "cost-only")))
    out.append("")

    out += ["## Sessions per unit", "", "| Unit | Session | Role | Join | Turns | API calls | First ctx | Peak ctx "
            "| Cache read | Output | Subagents (cache read) |", "|---|---|---|---|--:|--:|--:|--:|--:|--:|--:|"]
    for u in units:
        if u["kind"] == "talk":
            continue
        for s in u["sessions"]:
            out.append("| %s | %s | %s | %s | %d | %d | %s | %s | %s | %s | %d (%s) |" % (
                u["unit"], s["id"], s["role"], s.get("join") or "-", s["turns"], s["api_calls"], k(s["ctx_first"]),
                k(s["ctx_peak"]), k(s["cache_read"]), k(s.get("output", 0)), s["subagents"],
                k(s.get("subagent_cache_read", 0))))
    out.append("")

    scored = [u for u in units if u["kind"] != "talk" and u["reads"]]
    out += ["## Units with reads", "",
            "| Unit | St | Rev tier | Read code/doc | Prec | Golden in prompt | Disc | Reread "
            "| EditFail/Ask/GitProbe/TestFail | Find | Surv |",
            "|---|---|---|--:|--:|--:|--:|--:|---|--:|--:|"]
    for u in scored:
        m, f, o = u["metrics"], u["friction"], u["outcome"]
        out.append("| %s | %s | %s | %d/%d | %s | %d/%d | %d | %d | %d/%d/%d/%d | %d | %s |" % (
            u["unit"], u["status"][:4], o.get("review_tier") or ("y" if o["has_review"] else "-"),
            m["read_lines_code"], m["read_lines_doc"], pct(m["precision"]),
            m["golden_in_prompt"], m["golden"], m["discovery"], m["rereads"],
            f["edit_fail"], f["ask_user"], f["git_probe"], f["tests_fail"], o["review_found"], pct(o["survival"])))
    out.append("")

    disc = {}
    for u in scored:
        for r in u["reads"]:
            if r["class"] == "discovery":
                d = disc.setdefault(r["file"], [0, 0, set()])
                d[0] += 1
                d[1] += bool(r.get("golden"))
                d[2].add(u["unit"])
    out += ["## Most discovered files (plan never named)", "", "| File | Reads | Golden hit | Units |",
            "|---|--:|--:|--:|"]
    for f, (n, g, us) in sorted(disc.items(), key=lambda x: (-len(x[1][2]), -x[1][0]))[:15]:
        out.append("| %s | %d | %d | %d |" % (f, n, g, len(us)))
    out.append("")

    top = sorted(((r, u["unit"]) for u in scored for r in u["reads"] if r["class"] != "outside"),
                 key=lambda x: -x[0]["carry"])[:10]
    out += ["## Costliest reads (token x api calls after)", "", "| Unit | File | Call | Class | Lines | Carry |",
            "|---|---|--:|---|--:|--:|"]
    for r, un in top:
        out.append("| %s | %s | %d | %s | %s | %s |" % (un, r["file"], r["call"], r["class"], r["lines"], k(r["carry"])))
    out.append("")

    out += carry_table([u for u in units if u.get("carry_split") and u["kind"] != "talk"])

    unused = {}
    for u in scored:
        for p in u["metrics"]["unused_planned"]:
            unused[p] = unused.get(p, 0) + 1
    if unused:
        out += ["## Planned code files never needed by the final diff", ""]
        out += ["- %s x%d" % (p, n) for p, n in sorted(unused.items(), key=lambda x: -x[1])[:10]]
        out.append("")
    talk = by.get("talk", [])
    if talk:
        out.append("No-commit sessions: %d, cache read total %s" % (
            len(talk), k(sum(s["cache_read"] for u in talk for s in u["sessions"]))))
    print("\n".join(out))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("extract")
    e.add_argument("session", help="id, id prefix, or path to .jsonl")
    for name in ("sweep", "report"):
        p = sub.add_parser(name)
        p.add_argument("--since", default=(dt.date.today() - dt.timedelta(days=14)).isoformat())
    a = ap.parse_args()
    if a.cmd == "extract":
        path = a.session if a.session.endswith(".jsonl") else \
            next(iter(sorted(glob.glob(os.path.join(PROJECTS, a.session + "*.jsonl")))), None)
        if not path:
            sys.exit("no transcript for %s" % a.session)
        json.dump(parse_session(path), sys.stdout, indent=1, ensure_ascii=False)
        print()
    elif a.cmd == "sweep":
        units = sweep(a.since)
        n = {}
        for u in units:
            n[u["kind"]] = n.get(u["kind"], 0) + 1
        print("swept %d unit(s) since %s: %s -> %s" % (len(units), a.since, n, LOG))
    else:
        report(a.since)


if __name__ == "__main__":
    main()
