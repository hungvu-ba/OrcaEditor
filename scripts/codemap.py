#!/usr/bin/env python3
"""Code + doc map for this repo. Session look here first, open file by line range, not grep wide.
Ported from the PZMod repo (tools/codemap.py, see Plan/... codemap-solution.md for the write-up).

  build [Area ...]|--all   write .map/<area>/code.md (Area: ext, webview, scripts) + .map/docs.md
  sym <Name>               definition file:start-end + callers + tests + doc mentions (whole repo)
  doc "<heading part>"     one doc section text (CLAUDE.md-referenced Plan/*.md, README, ...)

Why: PZMod judged 2026-09-24 that search + whole-file reads for one section/symbol name burn a lot
of context (every token in context is re-read on every later model call). sym/doc parse live -> never
stale.

Deviation from the PZMod design: PZMod is many independent Lua mods (own SPEC.md each, no cross-mod
require) so it scopes every command to one mod. This repo is one product with real cross-file TS
imports (media/webview/*.ts imports src/shared/*.ts) and one shared doc set (Plan/*.md), so `sym`/
`doc` search the whole repo -- output is capped (CALL_CAP/DOC_CAP), not proportional to repo size.
Only `build` still splits by area, to keep .map/<area>/code.md small enough that opening one doesn't
pull in the other two.

TS defs matched at column 0 (`export function f(`, `function f(`) or column 2 inside a column-0
class (`export class C {` ... `  method(args) {`). One-liner (body opens+closes on the def line) ->
end = start. Multi-line signatures, arrow-function exports, and object-literal methods are not
matched -- read the enclosing file for those. Method call-sites are found by `.name(` (any object),
since a text search can't resolve which class an instance belongs to; treat matches as candidates,
use code-review-graph for exact resolution.

Examples:
  python3 scripts/codemap.py build --all
  python3 scripts/codemap.py sym collectHaystack
  python3 scripts/codemap.py doc "US-23.10"
"""
import argparse
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AREAS = {
    "ext": {"code": [("src", ".ts")], "tests": ["test/host"]},
    "webview": {"code": [("media/webview", ".ts")], "tests": ["test/webview", "test/roundtrip"]},
    "scripts": {"code": [("scripts", ".py")], "tests": []},
}
DOC_EXCLUDE_ROOT = {"CHANGELOG.md", "THIRD-PARTY-NOTICES.md", "Update History.md", "CLAUDE.md"}
DOC_EXCLUDE_DIRS = {"Archived", "Skill Analysis"}  # superseded / process logs, not reference docs
SKIP_DIRS = {"__pycache__", ".map", "node_modules"}

TS_EXPORT_FN = re.compile(r"^export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)")
TS_LOCAL_FN = re.compile(r"^(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)")
TS_CLASS = re.compile(r"^(export\s+)?(abstract\s+)?class\s+([A-Za-z_$][\w$]*)")
TS_METHOD = re.compile(
    r"^  ((?:private|public|protected|static|readonly|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)[^{;]*\{"
)
PY_DEF = re.compile(r"^(\s*)(async\s+)?def\s+(\w+)\s*\(([^)]*)\)")
PY_CLASS = re.compile(r"^(\s*)class\s+(\w+)")
HEAD_RE = re.compile(r"^(#{1,6})\s+(.*\S)")
CALL_CAP, DOC_CAP = 40, 15


def read(path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read().split("\n")


def walk_ext(base, ext):
    out = []
    for d, dirs, fs in os.walk(base):
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
        out += [(os.path.relpath(os.path.join(d, f), ROOT), os.path.join(d, f), ext) for f in fs if f.endswith(ext)]
    return out


def area_files(area):
    cfg = AREAS[area]
    out = []
    for reldir, ext in cfg["code"]:
        out += walk_ext(os.path.join(ROOT, reldir), ext)
    for reldir in cfg["tests"]:
        base = os.path.join(ROOT, reldir)
        if os.path.isdir(base):
            out += walk_ext(base, ".ts")
    return sorted(out)


def all_files():
    """Every area's files, plus loose test/*.ts (test/unit.ts, ...) that no area owns -- they
    exercise both ext and webview code, so sym/doc still needs to find calls/tests in them even
    though they're not part of any area's overview map."""
    out = []
    for area in AREAS:
        out += area_files(area)
    tdir = os.path.join(ROOT, "test")
    out += [(os.path.relpath(os.path.join(tdir, f), ROOT), os.path.join(tdir, f), ".ts")
            for f in os.listdir(tdir) if f.endswith(".ts") and os.path.isfile(os.path.join(tdir, f))]
    return sorted(set(out))


def doc_files():
    out = []
    for f in sorted(os.listdir(ROOT)):
        p = os.path.join(ROOT, f)
        if f.endswith(".md") and f not in DOC_EXCLUDE_ROOT and os.path.isfile(p):
            out.append(p)
    plan = os.path.join(ROOT, "Plan")
    for d, dirs, fs in os.walk(plan):
        dirs[:] = [x for x in dirs if x not in DOC_EXCLUDE_DIRS]
        out += [os.path.join(d, f) for f in fs if f.endswith(".md")]
    return sorted(out)


def _ts_block_end(lines, start, indent):
    """1-based end line: first `<indent spaces>}` after start, or start itself if the def line
    already opens and closes its own body (one-liner)."""
    ln = lines[start]
    brace = ln.find("{")
    if brace != -1 and ln[brace:].count("{") - ln[brace:].count("}") <= 0 and ln.rstrip().endswith("}"):
        return start + 1
    close = re.compile(r"^%s\}\s*$" % (" " * indent))
    for j in range(start + 1, len(lines)):
        if close.match(lines[j]):
            return j + 1
    return start + 1


def defs_ts(lines):
    out, classes = [], []
    i = 0
    while i < len(lines):
        ln = lines[i]
        m = TS_CLASS.match(ln)
        if m:
            end = _ts_block_end(lines, i, 0)
            out.append((m.group(3), None, i + 1, end, not m.group(1)))
            classes.append((m.group(3), i + 1, end))
            i += 1
            continue
        m = TS_EXPORT_FN.match(ln) or TS_LOCAL_FN.match(ln)
        if m:
            local = m.re is TS_LOCAL_FN
            name, args = m.group(2), m.group(3)
            end = _ts_block_end(lines, i, 0)
            out.append((name, args, i + 1, end, local))
            i = end
            continue
        i += 1
    for cname, cstart, cend in classes:
        k = cstart  # 1-based, line right after `class ... {`
        while k < cend:
            m = TS_METHOD.match(lines[k - 1])
            if m:
                mods = m.group(1) or ""
                end = _ts_block_end(lines, k - 1, 2)
                out.append((cname + "." + m.group(2), m.group(3), k, end, "private" in mods))
                k = end + 1
                continue
            k += 1
    return out


def defs_py(lines):
    out = []
    for i, ln in enumerate(lines):
        m = PY_DEF.match(ln)
        cls = None if m else PY_CLASS.match(ln)
        if not m and not cls:
            continue
        indent = len(m.group(1)) if m else len(cls.group(1))
        name = m.group(3) if m else cls.group(2)
        args = m.group(4) if m else None
        end = len(lines)
        for j in range(i + 1, len(lines)):
            s = lines[j]
            if s.strip() and len(s) - len(s.lstrip()) <= indent:
                end = j
                break
        out.append((name, args, i + 1, end, indent > 0 or name.startswith("_")))
    return out


def defs(lines, ext):
    return defs_py(lines) if ext == ".py" else defs_ts(lines)


def header(lines, ext):
    for ln in lines[:20]:
        s = ln.strip()
        if not s:
            continue
        if ext == ".py":
            return s.lstrip("# ").strip()[:110] if s.startswith("#") else ""
        if s.startswith("//"):
            return s.lstrip("/ ").strip()[:110]
        if s.startswith("/**") or s.startswith("/*"):
            s2 = s.lstrip("/*").strip()
            if s2:
                return s2[:110]
            continue
        if s.startswith("*/"):
            continue
        if s.startswith("*"):
            s2 = s.lstrip("* ").strip()
            if s2:
                return s2[:110]
            continue
        return ""
    return ""


def headings(lines):
    """[(level, text, start, end)] outside code fences."""
    hs, fence = [], False
    for i, ln in enumerate(lines):
        if ln.startswith("```"):
            fence = not fence
            continue
        m = None if fence else HEAD_RE.match(ln)
        if m:
            hs.append([len(m.group(1)), m.group(2), i + 1, len(lines)])
    for a, h in enumerate(hs):
        nxt = next((b for b in hs[a + 1:] if b[0] <= h[0]), None)
        if nxt:
            h[3] = nxt[2] - 1
    return hs


def _sig(name, args):
    """`args is None` marks a class entry (no call signature)."""
    return name if args is None else "%s(%s)" % (name, args)


def build(area):
    files = area_files(area)
    code = ["# %s code map (generated, do not edit)" % area, "",
            "Line = def start-end; read by range. Local/private fn not listed: `sym <name>`.", ""]
    for label, path, ext in files:
        lines = read(path)
        ds = defs(lines, ext)
        h = header(lines, ext)
        code.append("%s## %s (%d)%s" % ("" if not code[-1] else "\n", label, len(lines), " -- " + h if h else ""))
        pub = [d for d in ds if not d[4]]
        loc = [d for d in ds if d[4]]
        code += ["- %s %d-%d" % (_sig(d[0], d[1]), d[2], d[3]) for d in pub]
        if loc:
            code.append("- %d local/private fn (sym by name)" % len(loc))
    out = os.path.join(ROOT, ".map", area)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "code.md"), "w") as fh:
        fh.write("\n".join(code))
    return os.path.relpath(os.path.join(out, "code.md"), ROOT)


def build_docs():
    docs = ["# doc map (generated, do not edit)", "",
            'Heading + line range. `python3 scripts/codemap.py doc "<part>"` prints one section.', ""]
    for path in doc_files():
        lines = read(path)
        docs.append("## %s (%d)" % (os.path.relpath(path, ROOT), len(lines)))
        docs += ["%s%s %d-%d" % ("  " * (lv - 1), t[:100], s, e) for lv, t, s, e in headings(lines)]
        docs.append("")
    out = os.path.join(ROOT, ".map")
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "docs.md"), "w") as fh:
        fh.write("\n".join(docs))
    return os.path.relpath(os.path.join(out, "docs.md"), ROOT)


def sym(name):
    short = name.rsplit(".", 1)[-1]
    files = all_files()
    hits = []
    for label, path, ext in files:
        for d in defs(read(path), ext):
            if d[0] == name or (name == short and d[0].rsplit(".", 1)[-1] == short):
                hits.append("%s:%d-%d  %s%s" % (label, d[2], d[3], _sig(d[0], d[1]), "  [local]" if d[4] else ""))
    print("def:" if hits else "def: none (multi-line signature, arrow export, or object-literal method -- grep)")
    for h in hits:
        print("  " + h)
    dotted = "." in name
    call_re = re.compile(r"\.%s\s*\(" % re.escape(short)) if dotted else re.compile(r"(?<!\w)%s\s*\(" % re.escape(short))
    def_res = (TS_EXPORT_FN, TS_LOCAL_FN, TS_CLASS, TS_METHOD, PY_DEF, PY_CLASS)
    calls = []
    for label, path, ext in files:
        for i, ln in enumerate(read(path)):
            s = ln.strip()
            if s.startswith("//") or s.startswith("*") or s.startswith("#"):
                continue
            if call_re.search(ln) and not any(rx.match(ln) for rx in def_res):
                calls.append("%s:%d: %s" % (label, i + 1, ln.strip()[:110]))
    src = [c for c in calls if not c.startswith("test/")]
    tst = [c for c in calls if c.startswith("test/")]
    for title, rows in (("callers" + (" (candidates: any `.%s(`)" % short if dotted else ""), src), ("tests", tst)):
        print("%s: %d%s" % (title, len(rows), " (first %d)" % CALL_CAP if len(rows) > CALL_CAP else ""))
        for r in rows[:CALL_CAP]:
            print("  " + r)
    ment = []
    for path in doc_files():
        lines = read(path)
        hs = headings(lines)
        for i, ln in enumerate(lines):
            if name in ln:
                sec = next((h[1] for h in reversed(hs) if h[2] <= i + 1), "")
                ment.append("%s:%d  [%s]" % (os.path.relpath(path, ROOT), i + 1, sec[:60]))
    print("docs: %d%s" % (len(ment), " (first %d)" % DOC_CAP if len(ment) > DOC_CAP else ""))
    for m in ment[:DOC_CAP]:
        print("  " + m)


def doc(part, full):
    found = []
    for path in doc_files():
        lines = read(path)
        for lv, t, s, e in headings(lines):
            if part.lower() in t.lower():
                found.append((path, lines, lv, t, s, e))
    if not found:
        sys.exit("no heading with %r in any doc (see .map/docs.md, or `build` if stale)" % part)
    if len(found) > 1:
        exact = [f for f in found if re.search(r"(?<![\w-])%s(?![\w.])" % re.escape(part), f[3])]
        found = exact if len(exact) == 1 else found
    if len(found) > 1:
        print("%d headings match, pick one:" % len(found))
        for path, _, lv, t, s, e in found:
            print("  %s:%d-%d  %s %s" % (os.path.relpath(path, ROOT), s, e, "#" * lv, t[:90]))
        return
    path, lines, lv, t, s, e = found[0]
    subs = [h for h in headings(lines) if s < h[2] <= e and h[0] == lv + 1]
    if e - s > 150 and subs and not full:
        print("%s:%d-%d is %d lines; subsections (doc again with one, or --full):" % (
            os.path.relpath(path, ROOT), s, e, e - s + 1))
        for _, st, a, b in subs:
            print("  %d-%d  %s" % (a, b, st[:90]))
        return
    print("%s:%d-%d" % (os.path.relpath(path, ROOT), s, e))
    print("\n".join(lines[s - 1:e]))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("areas", nargs="*", choices=list(AREAS))
    b.add_argument("--all", action="store_true")
    s = sub.add_parser("sym")
    s.add_argument("name")
    d = sub.add_parser("doc")
    d.add_argument("part")
    d.add_argument("--full", action="store_true")
    a = ap.parse_args()
    if a.cmd == "build":
        areas = list(AREAS) if a.all else a.areas
        if not areas:
            sys.exit("build <Area ...> (ext, webview, scripts) or --all")
        for area in areas:
            print("map " + build(area))
        print("map " + build_docs())
    elif a.cmd == "sym":
        sym(a.name)
    else:
        doc(a.part, a.full)


if __name__ == "__main__":
    main()
