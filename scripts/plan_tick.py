#!/usr/bin/env python3
"""Plan tick. Shim over the harness task CLI: the status goes to harness.db, the CLI re-renders the plan mirror.

  python3 scripts/plan_tick.py <plan.md> T1.4 ◐   # code done: -> review (waiting for review)
  python3 scripts/plan_tick.py <plan.md> T1.4 ☑   # review done (or tier 1): -> done, mirror hides its prompt blocks

A relative plan path resolves against the main checkout (Plan/ lives only there), so a worktree session
passes the same path. Prompts of a done task stay in the DB: `task show <feature>/<id> --part code`.
Exit 1: plan not imported, unknown id, refused (done / dropped reopen only via `task tick <ref> open`),
hand-edited mirror (DB already updated: run `task import --update <plan.md>`).
AGENT_HARNESS overrides the harness checkout, HARNESS_DB the DB.
"""
import argparse
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from plan_check import MAIN_ROOT  # noqa: E402

HARNESS = os.environ.get("AGENT_HARNESS") or os.path.expanduser("~/Documents/Dev/agent-harness")
TASK = os.path.join(HARNESS, "tools", "task.py")
STATUS = {"◐": "review", "☑": "done"}


def db_path():
    return Path(os.environ.get("HARNESS_DB") or Path.home() / ".claude" / "harness" / "harness.db")


def feature_of(plan):
    """plan path -> (project root, feature key) by features.source. Raises ValueError when no feature mirrors it."""
    db = db_path()
    if not db.is_file():
        raise ValueError(f"no harness DB at {db}")
    con = sqlite3.connect(db.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        rows = con.execute("SELECT project, key, source FROM features").fetchall()
    finally:
        con.close()
    real = os.path.realpath(plan)
    hit = next(((p, k) for p, k, s in rows if os.path.realpath(os.path.join(p, s)) == real), None)
    if hit is None:
        raise ValueError(f"{plan} is not a mirror in {db}: task import it first")
    return hit


def task(*args):
    """Run the task CLI, output passes through -> its exit code."""
    return subprocess.run([sys.executable, TASK, *args]).returncode


def tick(plan, task_id, glyph):
    """-> exit code. ☑ re-renders the feature with --hide-done-prompts (the old md edit dropped the blocks)."""
    project, feature = feature_of(plan)
    code = task("tick", f"{feature}/{task_id}", STATUS[glyph], "--project", project)
    if code == 0 and glyph == "☑":
        code = task("render", feature, "--hide-done-prompts", "--project", project)
    return code


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("plan")
    ap.add_argument("task", help="task id, e.g. T1.4")
    ap.add_argument("status", choices=sorted(STATUS))
    a = ap.parse_args()
    plan = a.plan if os.path.isabs(a.plan) else os.path.join(MAIN_ROOT, a.plan)
    if not os.path.isfile(TASK):
        sys.exit(f"plan_tick: no task CLI at {TASK} (set AGENT_HARNESS)")
    try:
        code = tick(plan, a.task, a.status)
    except ValueError as e:
        sys.exit(f"plan_tick: {e}")
    sys.exit(1 if code else 0)


if __name__ == "__main__":
    main()
