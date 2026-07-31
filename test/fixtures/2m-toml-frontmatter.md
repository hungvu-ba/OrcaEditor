+++
title = "Hugo-style TOML front matter"
status = "draft"
weight = 3
draft = false
tags = ["hugo", "toml"]
date = 2025-10-30
updated = 2025-10-31T02:00:00+07:00

[params]
author = "Hùng Vũ"
theme = "orca"

[[menu.main]]
name = "home"
url = "/"
+++

# TOML front matter

Covers US-2.10: the `+++` pre-scan, a one-level `[params]` table (US-2.9's sub-grid), an array of tables (`[[menu.main]]`, US-2.9's compact JSON row), and TOML's native date types — all of it display-only, so `data-raw` must still round-trip byte-identical.
