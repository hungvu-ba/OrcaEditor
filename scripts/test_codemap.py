#!/usr/bin/env python3
"""codemap.py pure parts: TS/Python defs + end line, md heading ranges. Run: python3 scripts/test_codemap.py"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import codemap as cm  # noqa: E402

TS = """export function collect(a: number, b: number): number {
  return a + b;
}

function helper(x: number): number {
  return x * 2;
}

export function oneLiner(x: number): number { return x + 1; }

export class Registry {
  private items: string[] = [];

  add(name: string): void {
    this.items.push(name);
  }

  private reset(): void {
    this.items = [];
  }
}
""".split("\n")

PY = """def best(a, b):
    return a


class Registry:
    def __init__(self):
        self.items = []

    def add(self, name):
        self.items.append(name)


def _private(x):
    return x
""".split("\n")

MD = """# Title
intro
## D1 -- Claim
### US-1.1 . Claim
text
```
## not a heading in fence
```
### US-1.2 . Next
## D2 -- Rooms
end""".split("\n")


class TsDefs(unittest.TestCase):
    def test_top_level_and_one_liner(self):
        got = [(d[0], d[1], d[2], d[3], d[4]) for d in cm.defs_ts(TS) if "." not in d[0]]
        self.assertEqual(got, [
            ("collect", "a: number, b: number", 1, 3, False),
            ("helper", "x: number", 5, 7, True),
            ("oneLiner", "x: number", 9, 9, False),
            ("Registry", None, 11, 21, False),
        ])

    def test_class_methods_public_vs_private(self):
        got = [(d[0], d[4]) for d in cm.defs_ts(TS) if "." in d[0]]
        self.assertEqual(got, [("Registry.add", False), ("Registry.reset", True)])


class PyDefs(unittest.TestCase):
    def test_indent_bound_end(self):
        got = [(d[0], d[1], d[2], d[3], d[4]) for d in cm.defs_py(PY)]
        self.assertEqual(got, [
            ("best", "a, b", 1, 4, False),  # end includes the trailing blank lines before `class`
            ("Registry", None, 5, 12, False),
            ("__init__", "self", 6, 8, True),
            ("add", "self, name", 9, 12, True),
            ("_private", "x", 13, 15, True),
        ])


class Headings(unittest.TestCase):
    def test_ranges_skip_fence(self):
        got = [(h[0], h[1], h[2], h[3]) for h in cm.headings(MD)]
        self.assertEqual(got, [
            (1, "Title", 1, 11),
            (2, "D1 -- Claim", 3, 9),
            (3, "US-1.1 . Claim", 4, 8),
            (3, "US-1.2 . Next", 9, 9),
            (2, "D2 -- Rooms", 10, 11),
        ])


if __name__ == "__main__":
    unittest.main()
