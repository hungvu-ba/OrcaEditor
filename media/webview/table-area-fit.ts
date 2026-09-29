/**
 * Height-first column-width solver for fit-mode tables that must be squeezed
 * (US-19.27). Pure and deterministic: no DOM access, runs under Node in
 * `test/unit.ts`. Fed by measured break units (`table-area-measure.ts`).
 * Contracts and algorithm steps: `Plan/Table Area Fit — Code Plan.md`.
 */

export interface BreakUnit { w: number; gap: number }            // w = unit px; gap = px added before it when not first on its line
export interface CellLines { segments: BreakUnit[][]; cjkUnits: number; units: number; fixedH?: number } // one segment per hard line; empty cell = { segments: [], cjkUnits: 0, units: 0 }; fixedH = px height of img/svg/video/.katex content
export interface AreaFitColumn {
  cells: CellLines[];   // every row incl. header, row order
  hardMinW: number;     // border-box px (contract 3)
  readFloorW: number;   // border-box px (contract 5)
  looseFloorW: number;  // border-box px (contract 5)
  maxW: number;         // border-box px, single-line max-content
}
export interface AreaFitOptions {
  budgetW: number;                        // parent content width px
  padX: number;                           // cell padding + border px
  lineH: number;                          // cell line height px
  prevWidths?: (number | undefined)[];    // contract 8; undefined = column without an applied width
  hysteresis?: number;                    // default AREA_FIT_HYSTERESIS
  growOnlyCol?: number;                   // contract 8: only this column may widen; needs prevWidths
}
export interface AreaFitResult { widths: number[]; rowHeights: number[]; scroll: boolean } // rowHeights px (contract 4)
export const AREA_FIT_KNEE_EPSILON = 0.05;
export const AREA_FIT_KNEE_MAX_SHRINK = 0.15;
export const AREA_FIT_HYSTERESIS = 0.05;
export const AREA_FIT_RESIZE_HYSTERESIS = 0.02;

/**
 * Line model (contract 9): greedy fill of break units into `contentW`. A unit
 * starts a new line when it does not fit after the gap; a unit wider than the
 * line still takes a line of its own. Each segment (hard line) starts a new
 * line; an empty cell is 1 line.
 */
export function cellLineCount(cell: CellLines, contentW: number): number {
  let lines = 0;
  for (const seg of cell.segments) {
    lines++;
    let lineW = seg.length ? seg[0].w : 0;
    for (let i = 1; i < seg.length; i++) {
      const u = seg[i];
      if (lineW + u.gap + u.w > contentW) {
        lines++;
        lineW = u.w;
      } else {
        lineW += u.gap + u.w;
      }
    }
  }
  return Math.max(1, lines);
}

const EMPTY_CELL: CellLines = { segments: [], cjkUnits: 0, units: 0 };

/** One cell's breakpoints over the column's integer width range [lo, hi]. */
interface CellFit {
  /** need[k] = smallest border-box width in [lo, hi] giving ≤ k lines; Infinity when even hi gives more. need[need.length - 1] = lo. */
  need: number[];
  fixedH: number;
}

/** Solver step 2: breakpoints by binary search on `cellLineCount` (monotone non-increasing in width). */
function fitCell(cell: CellLines, lo: number, hi: number, padX: number): CellFit {
  const linesAt = (w: number): number => cellLineCount(cell, w - padX);
  const linesLo = linesAt(lo);
  const linesHi = linesAt(hi);
  const need = new Array<number>(linesLo + 1).fill(Infinity);
  need[linesLo] = lo;
  for (let k = linesLo - 1; k >= linesHi; k--) {
    let a = need[k + 1];
    if (linesAt(a) <= k) {
      need[k] = a;
      continue;
    }
    // linesAt(a) > k, linesAt(b) <= k
    let b = hi;
    while (b - a > 1) {
      const m = (a + b) >> 1;
      if (linesAt(m) <= k) b = m;
      else a = m;
    }
    need[k] = b;
  }
  return { need, fixedH: cell.fixedH ?? 0 };
}

/** Lines of the cell at border-box width `w` (w within the column's range). */
function linesAtWidth(f: CellFit, w: number): number {
  let k = 1;
  while (f.need[k] > w) k++;
  return k;
}

/** One trajectory point: `P` = widths the moves act on; `E` = `P` after free shrink (the widths applied). */
interface FitState {
  P: number[];
  /** lines[j][r] at P[j]. */
  lines: number[][];
  rowH: number[];
  /** Column of the row's strictly tallest cell at P; -1 when the tallest cells tie. */
  top: number[];
  H: number;
  E: number[];
  sumE: number;
}

interface FitMove { state: FitState; dH: number; cost: number; firstCol: number }

/**
 * Solver steps 1–6: floor assignment → scroll when it is wider than the
 * budget (contract 7); otherwise a greedy height-first trajectory of single
 * and joint row moves until no affordable move lowers H (contract 4), the
 * knee point on that trajectory (contract 6), then hysteresis against
 * `prevWidths` (contract 8). Free shrink (contract 5) is applied at every
 * trajectory point, so a move's cost counts the columns it forces back out of
 * their free shrink and width a free shrink releases stays spendable.
 */
export function solveAreaFit(cols: AreaFitColumn[], opts: AreaFitOptions): AreaFitResult {
  const { budgetW, padX, lineH, prevWidths, growOnlyCol } = opts;
  const hysteresis = opts.hysteresis ?? AREA_FIT_HYSTERESIS;
  const n = cols.length;
  const rows = cols.reduce((m, c) => Math.max(m, c.cells.length), 0);
  // Contracts 3 + 5: integer px, hardMinW ≤ looseFloorW ≤ readFloorW ≤ maxW.
  const hard = cols.map((c) => Math.ceil(c.hardMinW));
  const hi = cols.map((c, j) => Math.max(hard[j], Math.ceil(c.maxW)));
  const read = cols.map((c, j) => Math.min(hi[j], Math.max(hard[j], Math.ceil(c.readFloorW))));
  const loose = cols.map((c, j) => Math.min(read[j], Math.max(hard[j], Math.ceil(c.looseFloorW))));
  const fits = cols.map((c, j) =>
    Array.from({ length: rows }, (_, r) => fitCell(c.cells[r] ?? EMPTY_CELL, loose[j], hi[j], padX)),
  );
  const cellH = (j: number, r: number, lines: number): number => Math.max(lines * lineH, fits[j][r].fixedH);
  const colLines = (j: number, w: number): number[] => fits[j].map((f) => linesAtWidth(f, w));
  const sum = (a: number[]): number => a.reduce((s, w) => s + w, 0);
  /** Row heights at arbitrary widths (clamped into each column's fit range). */
  const heightsAt = (widths: number[]): number[] => {
    const rowH = new Array<number>(rows).fill(0);
    const lines = widths.map((w, j) => colLines(j, Math.max(loose[j], Math.min(hi[j], w))));
    for (let r = 0; r < rows; r++) for (let j = 0; j < n; j++) rowH[r] = Math.max(rowH[r], cellH(j, r, lines[j][r]));
    return rowH;
  };

  // Step 6, growOnlyCol (contract 8): skip steps 1–5. Every other column keeps
  // its prev width; growOnlyCol widens (never narrows) to the candidate
  // minimizing H within the spare the others leave under budgetW.
  if (growOnlyCol !== undefined && prevWidths) {
    const others = cols.map((_, j) => (j === growOnlyCol ? 0 : prevWidths[j] ?? hard[j]));
    const prevJ = prevWidths[growOnlyCol] ?? hard[growOnlyCol];
    const widths = cols.map((_, j) => prevWidths[j] ?? hard[j]);
    // prevWidths can go stale between re-fits (e.g. the panel narrowed, or a
    // column's hardMinW grew, since they were applied); only trust the fast
    // path when they are still feasible, else fall through to a full solve
    // instead of returning an over-budget or below-hardMinW result.
    if (sum(widths) <= budgetW && widths.every((w, j) => w >= hard[j])) {
      const maxAllowed = Math.min(hi[growOnlyCol], budgetW - sum(others));
      if (maxAllowed <= prevJ) return { widths, rowHeights: heightsAt(widths), scroll: false };
      const candidates = new Set<number>([prevJ]);
      for (const f of fits[growOnlyCol]) for (const w of f.need) if (w > prevJ && w <= maxAllowed) candidates.add(w);
      let bestW = prevJ;
      let bestH = Infinity;
      for (const w of [...candidates].sort((x, y) => x - y)) {
        widths[growOnlyCol] = w;
        const h = sum(heightsAt(widths));
        if (h < bestH) {
          bestH = h;
          bestW = w;
        }
      }
      widths[growOnlyCol] = bestW;
      return { widths, rowHeights: heightsAt(widths), scroll: false };
    }
  }

  const settle = (P: number[], lines: number[][]): FitState => {
    const rowH = new Array<number>(rows).fill(-1);
    const top = new Array<number>(rows).fill(-1);
    for (let r = 0; r < rows; r++) {
      for (let j = 0; j < n; j++) {
        const h = cellH(j, r, lines[j][r]);
        if (h > rowH[r]) {
          rowH[r] = h;
          top[r] = j;
        } else if (h === rowH[r]) {
          top[r] = -1;
        }
      }
    }
    const bottleneck = new Array<boolean>(n).fill(false);
    for (const j of top) if (j >= 0) bottleneck[j] = true;
    // Free shrink: narrowest width keeping every row height; only a column
    // that is no row's strictly tallest cell may go below readFloorW.
    const E = P.map((_, j) => {
      let w = bottleneck[j] ? read[j] : loose[j];
      for (let r = 0; r < rows; r++) {
        const f = fits[j][r];
        const k = Math.min(f.need.length - 1, Math.floor(rowH[r] / lineH + 1e-9));
        w = Math.max(w, f.need[k]);
      }
      return w;
    });
    return {
      P,
      lines,
      rowH,
      top,
      H: rowH.reduce((s, h) => s + h, 0),
      E,
      sumE: E.reduce((s, w) => s + w, 0),
    };
  };

  /** Smallest width lowering cell (j, r) by one line; Infinity when an image holds it or maxW is reached. */
  const oneLineLess = (s: FitState, j: number, r: number): number => {
    const L = s.lines[j][r];
    return L * lineH > fits[j][r].fixedH ? fits[j][r].need[L - 1] : Infinity;
  };

  /** Candidate P's: (a) single — a column to its smallest breakpoint lowering a row it alone tops; (b) joint — every tied tallest cell of a row one line down together. */
  const moves = (s: FitState): number[][] => {
    const out: number[][] = [];
    for (let j = 0; j < n; j++) {
      let t = Infinity;
      for (let r = 0; r < rows; r++) if (s.top[r] === j) t = Math.min(t, oneLineLess(s, j, r));
      if (t < Infinity) out.push(s.P.map((w, i) => (i === j ? t : w)));
    }
    for (let r = 0; r < rows; r++) {
      if (s.top[r] !== -1) continue;
      const P = s.P.slice();
      let ok = true;
      for (let j = 0; j < n && ok; j++) {
        if (cellH(j, r, s.lines[j][r]) !== s.rowH[r]) continue;
        const t = oneLineLess(s, j, r);
        ok = t < Infinity;
        P[j] = Math.max(P[j], t);
      }
      if (ok) out.push(P);
    }
    return out;
  };

  // Step 1: floor assignment = every column at readFloorW, then free shrink.
  let s = settle(read.slice(), read.map((w, j) => colLines(j, w)));
  if (s.sumE > budgetW) return { widths: s.E, rowHeights: s.rowH, scroll: true };

  // Step 3: largest ΔH / Δ Σ widths; ties → smaller Σ widths → lower column index.
  const trajectory: FitState[] = [s];
  for (;;) {
    let best: FitMove | undefined;
    let bestRatio = -Infinity;
    const seen = new Set<string>();
    for (const P of moves(s)) {
      const key = P.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      const next = settle(P, P.map((w, j) => (w === s.P[j] ? s.lines[j] : colLines(j, w))));
      if (next.H >= s.H || next.sumE > budgetW) continue;
      const move: FitMove = {
        state: next,
        dH: s.H - next.H,
        cost: next.sumE - s.sumE,
        firstCol: P.findIndex((w, j) => w !== s.P[j]),
      };
      const ratio = move.cost > 0 ? move.dH / move.cost : Infinity;
      if (
        !best ||
        ratio > bestRatio ||
        (ratio === bestRatio && (move.cost < best.cost || (move.cost === best.cost && move.firstCol < best.firstCol)))
      ) {
        best = move;
        bestRatio = ratio;
      }
    }
    if (!best) break;
    s = best.state;
    trajectory.push(s);
  }

  // Step 4 (contract 6): knee — the earliest (smallest Σ widths) trajectory
  // point within AREA_FIT_KNEE_EPSILON of the trajectory's final H. Its E is
  // already free-shrunk (step 5), integer px. Below the knee floor, hand the
  // gap back ∝ (maxW − width), capped at maxW (no hand-back after this point).
  const hEnd = trajectory[trajectory.length - 1].H;
  const kneeThreshold = hEnd * (1 + AREA_FIT_KNEE_EPSILON);
  const knee = trajectory.find((p) => p.H <= kneeThreshold) ?? trajectory[trajectory.length - 1];
  const kneeFloor = budgetW - Math.min(AREA_FIT_KNEE_MAX_SHRINK * budgetW, sum(hi) - budgetW);
  let widths = knee.E;
  if (knee.sumE < kneeFloor) {
    const gap = Math.min(Math.ceil(kneeFloor - knee.sumE), Math.floor(budgetW - knee.sumE));
    const room = widths.map((w, j) => hi[j] - w);
    const roomSum = sum(room);
    if (roomSum > 0) {
      // Floor each share, then hand the remainder px to lower column indices first (contract 4).
      widths = widths.map((w, j) => w + Math.min(room[j], Math.floor((gap * room[j]) / roomSum)));
      let rest = Math.min(gap, roomSum) - (sum(widths) - knee.sumE);
      for (let j = 0; j < n && rest > 0; j++) {
        const add = Math.min(rest, hi[j] - widths[j]);
        widths[j] += add;
        rest -= add;
      }
    }
  }
  let rowH = heightsAt(widths);

  // Step 6 (contract 8): hysteresis against prevWidths.
  if (prevWidths) {
    const candidate = cols.map((_, j) => prevWidths[j] ?? widths[j]);
    const feasible = sum(candidate) <= budgetW && candidate.every((w, j) => w >= hard[j]);
    if (feasible) {
      const candH = sum(heightsAt(candidate));
      const freshH = sum(rowH);
      if (!(freshH < candH * (1 - hysteresis))) {
        widths = candidate;
        rowH = heightsAt(candidate);
      }
    }
  }

  return { widths, rowHeights: rowH, scroll: false };
}
