#!/usr/bin/env python3
"""Plan tick. Flip a break-tasks plan task's status; ☑ also removes its prompt blocks.

  python3 scripts/plan_tick.py <plan.md> T1.4 ◐   # code done: ☐ -> ◐ (waiting for review)
  python3 scripts/plan_tick.py <plan.md> T1.4 ☑   # review done (or tier 1): ☐/◐ -> ☑ + remove every ```text block

A relative plan path resolves against the main checkout (Plan/ lives only there), so a worktree session
passes the same path. Each ```text block goes with its fences; Verify, Notes and everything outside the blocks stay.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from plan_check import MAIN_ROOT, TASK_HEAD  # noqa: E402

ALLOWED_FROM = {"◐": ("☐",), "☑": ("☐", "◐")}


def tick(lines, task_id, status):
    """lines -> (new lines, old status, removed block count). Raises ValueError on a bad task/transition."""
    start = next((i for i, l in enumerate(lines) if (m := TASK_HEAD.match(l)) and m.group(2) == task_id), None)
    if start is None:
        raise ValueError(f"{task_id}: no '### <status> {task_id}' heading")
    old = TASK_HEAD.match(lines[start]).group(1)
    if old not in ALLOWED_FROM[status]:
        raise ValueError(f"{task_id}: {old} -> {status} not allowed (from {'/'.join(ALLOWED_FROM[status])} only)")
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith(("## ", "### "))), len(lines))
    head = lines[start]
    pos = head.index(old)
    out = lines[:start] + [head[:pos] + status + head[pos + len(old):]]
    removed, in_block = 0, False
    for line in lines[start + 1:end]:
        if in_block:
            in_block = line.strip() != "```"
            continue
        if status == "☑" and line.strip() == "```text":
            in_block = True
            removed += 1
            continue
        if removed and line.strip() == "" and out[-1].strip() == "":
            continue  # a removed block leaves two blank lines
        out.append(line)
    if in_block:
        raise ValueError(f"{task_id}: unclosed ```text block")
    return out + lines[end:], old, removed


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("plan")
    ap.add_argument("task", help="task id, e.g. T1.4")
    ap.add_argument("status", choices=sorted(ALLOWED_FROM))
    a = ap.parse_args()
    plan = a.plan if os.path.isabs(a.plan) else os.path.join(MAIN_ROOT, a.plan)
    with open(plan, encoding="utf-8") as fh:
        lines = fh.readlines()
    try:
        new, old, removed = tick(lines, a.task, a.status)
    except ValueError as e:
        sys.exit(f"plan_tick: {e}")
    with open(plan, "w", encoding="utf-8") as fh:
        fh.writelines(new)
    note = f", removed {removed} prompt block(s)" if a.status == "☑" else ""
    print(f"{a.task}: {old} -> {a.status}{note}  ({plan})")


if __name__ == "__main__":
    main()
