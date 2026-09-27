#!/usr/bin/env python3
"""plan_tick.py over the harness task CLI: temp HARNESS_DB + temp copy of an archived plan, never the real DB / plans.
Run: python3 scripts/test_plan_tick.py"""

import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import plan_tick  # noqa: E402

PLAN = "Drag Handle Position — Task Plan.md"
SRC = os.path.join(plan_tick.MAIN_ROOT, "Plan", "Archived", "pre-db-2026-09-27", PLAN)


class PlanTickTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        root = os.path.join(self.tmp, "proj")
        os.makedirs(os.path.join(root, "Plan", "task breakdown"))
        subprocess.run(["git", "init", "-q", root], check=True)
        self.plan = os.path.join(root, "Plan", "task breakdown", PLAN)
        shutil.copyfile(SRC, self.plan)
        self.db = os.path.join(self.tmp, "t.db")
        self.env = {k: v for k, v in os.environ.items() if k not in ("HARNESS_PROJECT", "CLAUDE_PROJECT_DIR")}
        self.env["HARNESS_DB"] = self.db
        self.run_cmd([plan_tick.TASK, "import", self.plan], 0)

    def run_cmd(self, argv, code):
        r = subprocess.run([sys.executable, *argv], env=self.env, capture_output=True, text=True)
        self.assertEqual(r.returncode, code, r.stdout + r.stderr)
        return r.stdout + r.stderr

    def tick(self, task_id, glyph, code=0, plan=None):
        return self.run_cmd([os.path.join(HERE, "plan_tick.py"), plan or self.plan, task_id, glyph], code)

    def status(self, key):
        con = sqlite3.connect(self.db)
        try:
            return con.execute("SELECT status FROM tasks WHERE feature = 'drag-handle-position' AND key = ?",
                               (key,)).fetchone()[0]
        finally:
            con.close()

    def section(self, key):
        with open(self.plan, encoding="utf-8") as fh:
            text = fh.read()
        start = text.index(f" {key} · ")
        start = text.rindex("\n### ", 0, start) + 1
        end = text.find("\n### ", start + 1)
        return text[start:end if end >= 0 else len(text)]

    def test_review_then_done(self):
        self.assertIn("drag-handle-position/T1.1 ◐ review", self.tick("T1.1", "◐"))
        self.assertEqual(self.status("T1.1"), "review")
        self.assertTrue(self.section("T1.1").startswith("### ◐ T1.1 "))
        self.assertIn("```text", self.section("T1.1"))

        self.assertIn("drag-handle-position/T1.1 ☑ done", self.tick("T1.1", "☑"))
        self.assertEqual(self.status("T1.1"), "done")
        sec = self.section("T1.1")
        self.assertTrue(sec.startswith("### ☑ T1.1 "))
        self.assertNotIn("```text", sec)  # prompt blocks hidden in the mirror ...
        self.assertIn("```text", self.section("T1.2"))  # ... only for the done task
        out = self.run_cmd([plan_tick.TASK, "show", "drag-handle-position/T1.1", "--part", "code",
                            "--project", os.path.dirname(os.path.dirname(os.path.dirname(self.plan)))], 0)
        self.assertIn("```text", out)  # ... still in the DB

    def test_unknown_id(self):
        self.assertIn("no task drag-handle-position/T9.9", self.tick("T9.9", "◐", 1))

    def test_done_back_to_review_refused(self):
        self.tick("T1.2", "☑")
        self.tick("T1.2", "◐", 1)
        self.assertEqual(self.status("T1.2"), "done")

    def test_edited_mirror(self):
        with open(self.plan, "a", encoding="utf-8") as fh:
            fh.write("hand edit\n")
        self.assertIn("import --update", self.tick("T1.1", "◐", 1))
        self.assertEqual(self.status("T1.1"), "review")  # DB already committed

    def test_plan_not_imported(self):
        other = os.path.join(os.path.dirname(self.plan), "Other — Task Plan.md")
        shutil.copyfile(SRC, other)
        self.assertIn("not a mirror", self.tick("T1.1", "◐", 1, other))
        self.assertEqual(self.status("T1.1"), "open")


if __name__ == "__main__":
    unittest.main()
