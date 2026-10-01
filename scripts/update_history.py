#!/usr/bin/env python3
"""Append one row to Update History.md, keeping that file to today's rows only.

Before appending, every row dated before today moves (in order) to the end of
Update History_Archived.md, so Update History.md always holds just the current day.

  python3 scripts/update_history.py "Fix: <what changed, max 30 words>"
  python3 scripts/update_history.py --version 1.2.3 "Feature: <...>"

--version defaults to package.json's version; --date defaults to today (YYYY-MM-DD).
"""
import argparse
import datetime as dt
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CURRENT = os.path.join(ROOT, "Update History.md")
ARCHIVE = os.path.join(ROOT, "Update History_Archived.md")
HEADER = "# Update History\n\n| Version | Date | Update Content |\n| --- | --- | --- |\n"
MAX_WORDS = 30
ROW_DATE = re.compile(r"^\|[^|]*\|\s*(\d{4}-\d{2}-\d{2})\s*\|")


def read(path):
    if not os.path.exists(path):
        return HEADER
    with open(path, encoding="utf-8") as f:
        return f.read()


def write_atomic(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def split_rows(text):
    """Return (head_lines, rows): rows are dated table lines; blank placeholder rows are dropped."""
    head, rows = [], []
    for line in text.splitlines():
        if ROW_DATE.match(line):
            rows.append(line)
        elif not rows and not re.fullmatch(r"\|(\s*\|)+", line.strip()):
            head.append(line)
    return head, rows


def join(head, rows):
    return "\n".join(head + rows) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("content")
    ap.add_argument("--version")
    ap.add_argument("--date", default=dt.date.today().isoformat())
    args = ap.parse_args()

    content = " ".join(args.content.split())
    words = len(content.split())
    if words > MAX_WORDS:
        raise SystemExit(f"Update content is {words} words; max {MAX_WORDS}.")
    if "|" in content:
        raise SystemExit("Update content must not contain '|'.")
    version = args.version
    if not version:
        with open(os.path.join(ROOT, "package.json"), encoding="utf-8") as f:
            version = json.load(f)["version"]

    head, rows = split_rows(read(CURRENT))
    old = [r for r in rows if ROW_DATE.match(r).group(1) < args.date]
    keep = [r for r in rows if ROW_DATE.match(r).group(1) >= args.date]
    keep.append(f"| {version} | {args.date} | {content} |")

    # Compute both files first; archive is written before the current file so a crash
    # can at worst duplicate old rows, never lose them.
    if old:
        a_head, a_rows = split_rows(read(ARCHIVE))
        write_atomic(ARCHIVE, join(a_head, a_rows + old))
    write_atomic(CURRENT, join(head, keep))
    print(f"Appended to Update History.md; archived {len(old)} older row(s).")
    if old:
        print('Stage both: git add "Update History.md" "Update History_Archived.md"')


if __name__ == "__main__":
    main()
