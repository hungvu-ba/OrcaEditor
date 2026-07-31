---
this line has no colon so it is not key-shaped
title: still needs to round-trip byte-identical
---

# Front matter that fails to parse

Covers the raw-row fallback (US-2.9): YAML that `load()` throws on renders every source line verbatim instead of the error frame — `data-raw` must still be byte-identical after round-trip.
