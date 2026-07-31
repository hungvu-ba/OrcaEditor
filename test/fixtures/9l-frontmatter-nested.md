---
title: Nested YAML front matter
author:
  name: Hùng Vũ
  email: vu.van.hung@gmail.com
categories:
  - tutorial
  - markdown
summary: |
  First line of the block scalar.
  Second line, which the card clamps rather than stretching for.
matrix: [[a, b], [c, d]]
status: draft
---

# Nested front matter

Covers US-2.9's richer value shapes (one-level nested map, block-style list, block scalar, and a deeper structure that falls back to a compact JSON row) — the display is canonically reformatted, but `data-raw` must still round-trip byte-identical.
