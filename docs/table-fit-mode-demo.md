# Table Fit Width — Demo & behavior guide

Open this file in Orca Editor and run the **"Toggle Table Fit Width"** command
(Command Palette → *Orca MD Editor: Toggle Table Fit Width*) to switch every
table between two modes:

- **Scroll mode (default):** each column takes its natural single-line width; a
  table wider than the panel scrolls horizontally.
- **Fit mode (US-19.25):** columns shrink/wrap to fit the panel. A column bloated
  by one unusually long cell is *capped* so that cell wraps, freeing width for the
  rest. If the content genuinely cannot fit, the table falls back to scrolling.

The rule per column, when Fit mode is ON:

```
min_i  = min-content   (widest unbreakable word — the hard floor)
max_i  = max-content   (longest single-line cell)
p75_i  = 75th-percentile cell width  (the "typical" width)
cap_i  = (max_i > 1.8 × p75_i) ? clamp(p75_i × 1.3, 30ch, max_i) : max_i
comf_i = clamp(cap_i, min_i, max_i)
```

Then, with `W` = panel width:
- `Σ comf ≤ W` → use `comf` (compact, table is **not** stretched to full width).
- `Σ comf > W` → shrink each column proportionally to its slack `(comf − min)`.
- `Σ min > W`  → cannot fit → fall back to horizontal scroll.

Resize the panel (drag the editor split) with Fit mode ON to watch the columns
reflow. Narrow the panel enough on the last table and it will start scrolling.

---

## 1. Uniform short columns — nothing to shrink

Every column is short and similar, so there is no outlier and the total already
fits. Fit mode assigns each column its content width: the table just gets
**compact**, no wrapping, no stretching to fill the panel.

| ID | Qty | Unit | In stock |
| --- | --- | --- | --- |
| A1 | 3 | pcs | yes |
| A2 | 12 | box | yes |
| A3 | 1 | pcs | no |
| A4 | 7 | box | yes |

---

## 2. One outlier cell — the headline case (Case B)

Column **Note** is short on every row except one. In Scroll mode that single long
row forces the whole column wide, leaving big empty gaps on all other rows. In
Fit mode the column is **capped** (`max > 1.8 × p75`), so the long cell wraps onto
a few lines while the short rows keep a tight width — even though the table would
otherwise fit the panel. Case B applies whether or not space is scarce.

| Code | Note | Owner |
| --- | --- | --- |
| C-01 | ok | Mai |
| C-02 | ok | Lan |
| C-03 | This row alone carries a very long explanation that would otherwise stretch the whole Note column far wider than every other row needs | Huy |
| C-04 | ok | Mai |
| C-05 | pending | Lan |

---

## 3. Tiny index + long description + medium columns

A classic business table: a `#` column that only ever holds 1–3 digits should stay
tiny, while `Description` is legitimately long. Fit mode lets `#` collapse to its
content, caps/​wraps `Description`, and gives `Status`/`Owner` their modest widths.

| # | Description | Status | Owner |
| --- | --- | --- | --- |
| 1 | Collect the signed intake form from the front desk and attach the scanned copy to the case record | Open | Mai |
| 2 | Call back | Done | Huy |
| 3 | Verify the applicant's address against the utility bill before approving the discount tier | Open | Lan |
| 4 | Archive | Done | Mai |

---

## 4. Uniformly wide columns — even proportional shrink

Here every column is long, so there is **no** single outlier (each column's `p75`
is close to its `max`). When the total exceeds the panel, Fit mode shrinks all
columns proportionally to their slack and wraps them evenly, instead of singling
one out.

| Requirement | Rationale | Acceptance criteria |
| --- | --- | --- |
| The system shall persist the draft every thirty seconds | Users lose work when the browser crashes during long edits | Given an open draft, when thirty seconds elapse, then the draft is saved without a manual action |
| The export shall preserve heading levels | Downstream tools rely on the outline structure for navigation | Given a document with H1–H3, when exported, then the levels round-trip unchanged |

---

## 5. Many columns — shrink to fit the panel

Six content-bearing columns will overflow a normal panel in Scroll mode. Fit mode
packs them into the available width, wrapping the longer cells so the whole table
stays visible without a horizontal scrollbar.

| Name | Region | Segment | Last order | Notes | Account manager |
| --- | --- | --- | --- | --- | --- |
| Nguyen Trading Co. | North | Wholesale | 2026-07-01 | Prefers monthly invoicing and consolidated shipments | Mai Tran |
| Southbound Retail | South | Retail | 2026-06-18 | Seasonal buyer, high volume in Q4 only | Huy Le |
| Delta Foods | Central | Distributor | 2026-07-20 | Requires cold-chain confirmation on every delivery | Lan Pham |

---

## 6. Cannot fit — graceful fallback to scroll

Every cell here is one long **unbreakable** token, so the minimum content width of
all columns together already exceeds any reasonable panel (`Σ min > W`). Fit mode
detects this and **does not** force a broken layout — it leaves the table in
horizontal-scroll mode (use the floating scrollbar from US-19.24 to pan it).

| Token A | Token B | Token C | Token D |
| --- | --- | --- | --- |
| AAAAAAAAAAAAAAAAAAAAAAAAAAAA | BBBBBBBBBBBBBBBBBBBBBBBBBBBB | CCCCCCCCCCCCCCCCCCCCCCCCCCCC | DDDDDDDDDDDDDDDDDDDDDDDDDDDD |
| AAAAAAAAAAAAAAAAAAAAAAAAAAAA | BBBBBBBBBBBBBBBBBBBBBBBBBBBB | CCCCCCCCCCCCCCCCCCCCCCCCCCCC | DDDDDDDDDDDDDDDDDDDDDDDDDDDD |
