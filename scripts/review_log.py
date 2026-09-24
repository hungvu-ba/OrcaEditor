#!/usr/bin/env python3
"""Review run log. Append one entry per review run, read back after a week.

Log file: Plan/Skill Analysis/review-log.jsonl (one JSON object per line, never rewritten
except by `outcome`, which fills in a field on an existing entry). Ported from the PZMod repo.

  add      one review run (found/dedup/dropped/fixed/deferred/pending/loopback, minutes, real bugs)
  outcome  what the user decided on that run's pending items (accepted/dismissed/changed)
  miss     bug found later (manual test, user report) that a review tier should have caught
  show     last N entries
  report   markdown rollup for a date range + token/elapsed join on .claude/logs

Field mapping for bmad-quick-dev-solo step-04 (Classify categories):
  found = raw findings before dedup, dedup = distinct findings, dropped = reject,
  fixed = patch, deferred = defer, loopback = intent_gap + bad_spec, pending = held for the
  human without a loopback.

Examples:
  python3 scripts/review_log.py add --tool bmad-quick-dev-solo --tier 2 --scope us23-14-edit-comment \\
      --target workspace --files-reviewed 4 --found 9 --dedup 7 --dropped 2 --fixed 4 --deferred 1 \\
      --minutes 12 --bug "editComment route missing from provider switch"
  python3 scripts/review_log.py outcome 12 accepted=1 dismissed=0 changed=0
  python3 scripts/review_log.py miss --scope us23-14-edit-comment --tool bmad-quick-dev-solo \\
      --note "edit lost after reload"
  python3 scripts/review_log.py report --since 2026-09-24
"""
import argparse
import datetime as dt
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG = os.path.join(ROOT, "Plan", "Skill Analysis", "review-log.jsonl")
SESSION_LOGS = os.path.join(ROOT, ".claude", "logs")
TOOLS = ("review-commit", "bmad-quick-dev-solo", "code-review", "review-changes", "manual")
OUTCOME_KEYS = ("accepted", "dismissed", "changed")
COUNT_KEYS = ("found", "dedup", "dropped", "fixed", "deferred", "pending", "loopback", "reverted")

# ---------- storage ----------

def load(path):
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def save_all(path, entries):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        for e in entries:
            fh.write(json.dumps(e, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def append(path, entry):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


def next_id(entries):
    return 1 + max([e.get("id", 0) for e in entries] or [0])


def parse_ts(s):
    if not s:
        return dt.datetime.now().replace(microsecond=0)
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime(s, fmt)
        except ValueError:
            pass
    sys.exit("bad --ts %r (want YYYY-MM-DD or YYYY-MM-DDTHH:MM)" % s)


def parse_outcome(pairs):
    out = {k: 0 for k in OUTCOME_KEYS}
    for p in pairs:
        if "=" not in p:
            sys.exit("outcome wants key=N, got %r" % p)
        k, v = p.split("=", 1)
        if k not in OUTCOME_KEYS:
            sys.exit("outcome key must be one of %s" % (OUTCOME_KEYS,))
        out[k] = int(v)
    return out

# ---------- commands ----------

def cmd_add(a):
    entries = load(a.log)
    ts = parse_ts(a.ts)
    found = a.found
    dedup = a.dedup if a.dedup is not None else found
    settled = a.dropped + a.fixed + a.deferred + a.pending + a.loopback + a.reverted
    if dedup > found or settled > dedup:
        sys.exit("counts inconsistent: dedup<=found and dropped+fixed+deferred+pending+loopback+reverted<=dedup "
                 "(found=%d dedup=%d settled=%d)" % (found, dedup, settled))
    e = {
        "id": next_id(entries),
        "kind": "review",
        "ts": ts.isoformat(timespec="minutes"),
        "week": "%d-W%02d" % ts.isocalendar()[:2],
        "tool": a.tool,
        "tier": a.tier,
        "scope": a.scope,
        "target": a.target,
        "iteration": a.iteration,
        "reviewers": a.reviewers,
        "files_reviewed": a.files_reviewed,
        "found": found,
        "dedup": dedup,
        "dropped": a.dropped,
        "fixed": a.fixed,
        "deferred": a.deferred,
        "pending": a.pending,
        "loopback": a.loopback,
        "reverted": a.reverted,
        "minutes": a.minutes,
        "bugs": a.bug or [],
        "false_positives": a.fp or [],
        "note": a.note or "",
        "pending_outcome": parse_outcome(a.pending_outcome) if a.pending_outcome else None,
    }
    append(a.log, e)
    # context_audit.py parses this exact line shape (REVIEW_ID_RE) -- keep it stable
    print("logged id=%d %s tier%d %s found=%d dropped=%d fixed=%d pending=%d"
          % (e["id"], e["tool"], e["tier"], e["scope"], found, a.dropped, a.fixed, a.pending))
    if a.pending and not a.pending_outcome:
        print("when pending items are decided: python3 scripts/review_log.py outcome %d accepted=N dismissed=N changed=N"
              % e["id"])


def cmd_outcome(a):
    entries = load(a.log)
    hit = [e for e in entries if e.get("id") == a.id and e.get("kind") == "review"]
    if not hit:
        sys.exit("no review entry with id %d" % a.id)
    e = hit[0]
    oc = parse_outcome(a.pairs)
    if sum(oc.values()) > e["pending"]:
        sys.exit("outcome total %d exceeds pending %d on id %d" % (sum(oc.values()), e["pending"], a.id))
    e["pending_outcome"] = oc
    if a.note:
        e["note"] = (e.get("note", "") + " | " + a.note).strip(" |")
    save_all(a.log, entries)
    print("id=%d pending_outcome=%s" % (a.id, oc))


def cmd_miss(a):
    entries = load(a.log)
    ts = parse_ts(a.ts)
    e = {
        "id": next_id(entries),
        "kind": "miss",
        "ts": ts.isoformat(timespec="minutes"),
        "week": "%d-W%02d" % ts.isocalendar()[:2],
        "tool": a.tool,
        "tier": a.tier,
        "scope": a.scope,
        "note": a.note,
        "ref": a.ref or "",
    }
    append(a.log, e)
    print("logged miss id=%d (%s should have caught it)" % (e["id"], a.tool))


def cmd_show(a):
    entries = load(a.log)
    for e in entries[-a.last:]:
        if e.get("kind") == "miss":
            print("#%-3d %s MISS   %-20s %-30s %s" % (e["id"], e["ts"], e["tool"], e["scope"], e["note"]))
        else:
            oc = e.get("pending_outcome")
            ocs = "" if not oc else " -> acc%d/dis%d/chg%d" % (oc["accepted"], oc["dismissed"], oc["changed"])
            print("#%-3d %s %-20s t%d %-30s found=%-3d drop=%-3d fixed=%-3d defer=%-3d pend=%d loop=%d%s"
                  % (e["id"], e["ts"], e["tool"], e["tier"], e["scope"], e["found"], e["dropped"],
                     e["fixed"], e["deferred"], e["pending"], e["loopback"], ocs))

# ---------- session-usage join (.claude/logs/YYYY-MM-DD.md, written by the global Stop hook) ----------

ROW = re.compile(
    r"^\|\s*(?P<skills>[^|]*?)\s*\|\s*(?P<elapsed>[^|]*?)\s*\|\s*(?P<inp>[^|]*?)\s*\|\s*(?P<out>[^|]*?)\s*\|"
    r"\s*(?P<cc>[^|]*?)\s*\|\s*(?P<cr>[^|]*?)\s*\|\s*(?P<start>\d\d:\d\d)\s*\|\s*(?P<end>\d\d:\d\d)\s*\|"
    r"\s*(?P<turns>[^|]*?)\s*\|\s*(?P<agents>[^|]*?)\s*\|\s*`?(?P<sid>[0-9a-f]+)`?\s*\|")


def _num(s):
    s = s.replace(",", "").strip()
    return int(s) if s.isdigit() else 0


def _elapsed_min(s):
    m = 0.0
    for val, unit in re.findall(r"(\d+)\s*([hms])", s):
        m += int(val) * {"h": 60, "m": 1, "s": 1 / 60}[unit]
    return round(m, 1)


def session_rows(date):
    path = os.path.join(SESSION_LOGS, date.isoformat() + ".md")
    if not os.path.exists(path):
        return []
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            m = ROW.match(line)
            if not m or m.group("skills").startswith("**"):
                continue
            d = m.groupdict()
            rows.append({
                "skills": d["skills"], "elapsed_min": _elapsed_min(d["elapsed"]),
                "out": _num(d["out"]), "cache_read": _num(d["cr"]), "agents": _num(d["agents"]),
                "start": d["start"], "end": d["end"], "sid": d["sid"],
            })
    return rows


def _hm(s):
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def match_session(entry):
    ts = dt.datetime.fromisoformat(entry["ts"])
    rows = session_rows(ts.date())
    t = ts.hour * 60 + ts.minute
    cands = []
    for r in rows:
        s, e = _hm(r["start"]), _hm(r["end"])
        if e < s:
            e += 24 * 60
        if s - 5 <= t <= e + 5:
            cands.append(r)
    tagged = [r for r in cands if ("/" + entry["tool"]) in r["skills"]]
    if len(tagged) == 1:
        return tagged[0], ""
    if len(tagged) > 1:
        # several tagged sessions overlap; take the one that started last before ts
        best = max(tagged, key=lambda r: _hm(r["start"]) if _hm(r["start"]) <= t else -1)
        return best, "~%d overlap" % len(tagged)
    if len(cands) == 1:
        return cands[0], ""
    if not cands:
        return None, "no session"
    return None, "ambiguous(%d)" % len(cands)

# ---------- report ----------

def pct(a, b):
    return "%d%%" % round(100.0 * a / b) if b else "-"


def agg(entries):
    s = {k: sum(e.get(k, 0) for e in entries) for k in COUNT_KEYS}
    s["runs"] = len(entries)
    mins = [e["minutes"] for e in entries if e.get("minutes")]
    s["min_avg"] = round(sum(mins) / len(mins), 1) if mins else None
    oc = {k: 0 for k in OUTCOME_KEYS}
    for e in entries:
        if e.get("pending_outcome"):
            for k in OUTCOME_KEYS:
                oc[k] += e["pending_outcome"][k]
    s["oc"] = oc
    s["bugs"] = sum(len(e.get("bugs", [])) for e in entries)
    s["fps"] = sum(len(e.get("false_positives", [])) for e in entries)
    return s


def agg_row(label, tier, s):
    oc = s["oc"]
    return "| %s | %s | %d | %s | %d | %d | %d (%s) | %d | %d | %d | %d | %d/%d/%d | %s | %d | %d |" % (
        label, tier, s["runs"], s["min_avg"] if s["min_avg"] is not None else "-",
        s["found"], s["dedup"], s["dropped"], pct(s["dropped"], s["dedup"]), s["fixed"], s["deferred"],
        s["pending"], s["loopback"], oc["accepted"], oc["dismissed"], oc["changed"],
        pct(oc["dismissed"], sum(oc.values())), s["bugs"], s["fps"])


def block(title, entries):
    if not entries:
        return ["_%s: no entries_" % title, ""]
    lines = ["### %s" % title, "",
             "| tool | tier | runs | avg min | found | dedup | dropped (noise) | fixed | deferred | pending | loopback "
             "| pending decided: acc/dis/chg | dismissed% | real bugs | FPs |",
             "| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --- | --: | --: | --: |"]
    groups = {}
    for e in entries:
        groups.setdefault((e["tool"], e["tier"]), []).append(e)
    for (tool, tier), es in sorted(groups.items()):
        lines.append(agg_row(tool, str(tier), agg(es)))
    lines.append(agg_row("**all**", "", agg(entries)))
    lines.append("")
    undecided = [e["id"] for e in entries if e["pending"] and not e.get("pending_outcome")]
    if undecided:
        lines.append("Pending with no outcome yet (run `outcome <id> ...`): %s" % ", ".join("#%d" % i for i in undecided))
        lines.append("")
    return lines


def cmd_report(a):
    entries = load(a.log)
    until = parse_ts(a.until).date() if a.until else dt.date.today()
    since = parse_ts(a.since).date() if a.since else until - dt.timedelta(days=7)
    in_range = [e for e in entries if since <= dt.datetime.fromisoformat(e["ts"]).date() <= until]
    reviews = [e for e in in_range if e.get("kind") == "review"]
    misses = [e for e in in_range if e.get("kind") == "miss"]

    out = ["# Review log report %s .. %s" % (since, until), ""]
    out += block("Review runs in range", reviews)

    if reviews:
        out += ["### Per run (token/elapsed joined from .claude/logs by time window)", "",
                "| id | ts | tool | tier | scope | iter | reviewers | found | dropped | fixed | deferred | pending "
                "| min (logged) | session elapsed | out tok | cache read | agents | bugs |",
                "| --: | --- | --- | --- | --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --- |"]
        for e in reviews:
            row, why = match_session(e)
            out.append("| %d | %s | %s | %d | %s | %s | %s | %d | %d | %d | %d | %d | %s | %s | %s | %s | %s | %s |" % (
                e["id"], e["ts"][5:16], e["tool"], e["tier"], e["scope"], e.get("iteration") or "-",
                e.get("reviewers") if e.get("reviewers") is not None else "-", e["found"], e["dropped"],
                e["fixed"], e["deferred"], e["pending"], e["minutes"] if e.get("minutes") is not None else "-",
                ("%s%s" % (row["elapsed_min"], " (" + why + ")" if why else "")) if row else why,
                "{:,}".format(row["out"]) if row else "-", "{:,}".format(row["cache_read"]) if row else "-",
                row["agents"] if row else "-", "; ".join(e.get("bugs", [])).replace("|", "/") or "-"))
        out.append("")
        out.append("A matched session may hold work besides the review (tier 1 runs share the code session).")
        out.append("")

    out += ["### Misses in range (bugs a review tier should have caught)", ""]
    if misses:
        for e in misses:
            out.append("- #%d %s %s tier %s should have caught, %s: %s %s" % (
                e["id"], e["ts"][:10], e["tool"], e.get("tier") or "?", e["scope"], e["note"],
                ("(" + e["ref"] + ")") if e.get("ref") else ""))
    else:
        out.append("_none logged_")
    out.append("")

    out += ["### Questions to answer", "",
            "1. Cost: avg min and tokens per run by tier -- does tier 2 (in-session) stay well under the tier 3 panel?",
            "2. Noise: dropped% and dismissed% by tier; logged FPs.",
            "3. Value: real bugs per run; which misses should a higher tier have caught?",
            "4. Decision: keep the tier thresholds, move them, or go back to a panel on every change.", ""]
    print("\n".join(out))

# ---------- cli ----------

def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--log", default=LOG, help="log path (default Plan/Skill Analysis/review-log.jsonl)")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("add", help="log one review run")
    s.add_argument("--tool", required=True, choices=TOOLS)
    s.add_argument("--tier", required=True, type=int, choices=(1, 2, 3))
    s.add_argument("--scope", required=True, help="spec slug, US id, or short change name")
    s.add_argument("--target", default="workspace", help='"workspace", "commit <sha>", "range a..b"')
    s.add_argument("--iteration", type=int, default=1, help="step-04 specLoopIteration")
    s.add_argument("--reviewers", type=int, default=None, help="review sub-agents launched (0 = in-session)")
    s.add_argument("--files-reviewed", type=int, default=0)
    s.add_argument("--found", type=int, default=0, help="raw findings across reviewers + automated checks")
    s.add_argument("--dedup", type=int, default=None, help="after dedup (default = found)")
    s.add_argument("--dropped", type=int, default=0, help="rejected as noise")
    s.add_argument("--fixed", type=int, default=0, help="patched in this run")
    s.add_argument("--deferred", type=int, default=0, help="pre-existing, appended to deferred work")
    s.add_argument("--pending", type=int, default=0, help="held for a human decision, no loopback")
    s.add_argument("--loopback", type=int, default=0, help="intent_gap + bad_spec findings")
    s.add_argument("--reverted", type=int, default=0, help="patches reverted because they broke a test")
    s.add_argument("--minutes", type=float, default=None, help="wall time from start of review to classify done")
    s.add_argument("--bug", action="append", help="one line per real defect fixed (repeatable)")
    s.add_argument("--fp", action="append", help="one line per finding that was plainly wrong (repeatable)")
    s.add_argument("--note", default="")
    s.add_argument("--pending-outcome", nargs="*", metavar="k=N", help="accepted=N dismissed=N changed=N if known")
    s.add_argument("--ts", default=None, help="override timestamp YYYY-MM-DD[THH:MM]")
    s.set_defaults(fn=cmd_add)

    s = sub.add_parser("outcome", help="record what happened to a run's pending items")
    s.add_argument("id", type=int)
    s.add_argument("pairs", nargs="+", metavar="k=N", help="accepted=N dismissed=N changed=N")
    s.add_argument("--note", default="")
    s.set_defaults(fn=cmd_outcome)

    s = sub.add_parser("miss", help="bug found later that a review tier should have caught")
    s.add_argument("--scope", required=True)
    s.add_argument("--tool", required=True, choices=TOOLS, help="which tool should have caught it")
    s.add_argument("--tier", type=int, choices=(1, 2, 3), default=None, help="tier the change was reviewed at")
    s.add_argument("--note", required=True)
    s.add_argument("--ref", default="", help="commit / bug file row / issue")
    s.add_argument("--ts", default=None)
    s.set_defaults(fn=cmd_miss)

    s = sub.add_parser("show", help="print last N entries")
    s.add_argument("--last", type=int, default=20)
    s.set_defaults(fn=cmd_show)

    s = sub.add_parser("report", help="markdown rollup (default: last 7 days)")
    s.add_argument("--since", default=None)
    s.add_argument("--until", default=None)
    s.set_defaults(fn=cmd_report)

    a = p.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
