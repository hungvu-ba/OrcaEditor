/**
 * US-19.27 area fit — GATE A probe (T1.3; Code Plan "## GATE A — simulated vs
 * real line count"). Does the pure line model (`cellLineCount` over
 * `measureTableLines` units, contract 9) match Chromium's real line count well
 * enough to drive the solver? Prints the number tables that section records:
 * (a) simulated vs real lines per fixture × content width, with and without
 * `text-wrap: pretty`; (b) CJK glyph width / 1ch per preset; (c) solver and
 * measure time; (d) the current fit ladder's baseline area; (e) simulated vs
 * real row heights at the solver's widths. The only assertion is (a)'s green
 * threshold: ≥ 95% of cells exact and none off by more than one line.
 * Driven via window.TableAreaFitDebug (esbuild.js's tableAreaFitDebugConfig +
 * _harness.ts), like table-area-measure.spec.ts.
 */
import { test, expect, type Page } from '@playwright/test';
import { openEditor } from './_harness';
import { TABLE_1, TABLE_4, TABLE_8A, TABLE_8B, TABLE_20 } from './table-area-fixtures';

interface BreakUnit {
  w: number;
  gap: number;
}
interface CellLines {
  segments: BreakUnit[][];
  cjkUnits: number;
  units: number;
  fixedH?: number[];
}
interface AreaFitColumn {
  cells: CellLines[];
  hardMinW: number;
  readFloorW: number;
  looseFloorW: number;
  maxW: number;
}
interface AreaFitOptions {
  budgetW: number;
  padX: number;
  lineH: number;
}
interface AreaFitResult {
  widths: number[];
  rowHeights: number[];
  scroll: boolean;
}
interface Debug {
  measureTableLines(table: HTMLTableElement): CellLines[][];
  cellLineCount(cell: CellLines, contentW: number): number;
  solveAreaFit(cols: AreaFitColumn[], opts: AreaFitOptions): AreaFitResult;
}
/** One measured cell: the adapter's units plus its DOM one-line (max-content) width. */
interface MeasuredCell {
  lines: CellLines;
  domOneLineW: number;
}
/** Cell box metrics every probe shares (from the first cell's computed style). */
interface CellBox {
  padX: number;
  padY: number;
  lineH: number;
  chPx: number;
  font: string;
}
/**
 * Page-side helpers, installed once per page on window.__gateA — a
 * page.evaluate callback cannot call functions of this module.
 */
interface GateA {
  debug: Debug;
  box(cell: HTMLTableCellElement): CellBox;
  /** Every cell of `table` measured under the nowrap measure class, [row][col]. */
  measure(table: HTMLTableElement): MeasuredCell[][];
  /** Σ (w + gap) of the widest segment — the model's one-line width. */
  modelOneLineW(lines: CellLines): number;
  /** Rendered lines of `cell`: text-node and fixed-box rect centres clustered by half a line height; an empty cell counts 1 like the model. */
  realLines(cell: HTMLTableCellElement, lineH: number): number;
  /** Pin every column to a border-box width under .md-table-fit (table-layout: fixed), the way applyFitColumns does. */
  pin(table: HTMLTableElement, widths: number[]): void;
  unpin(table: HTMLTableElement): void;
  /** Contract 3/5 columns from the measured cells: hardMinW = widest unit, floors 30ch / 36ch (≥ 50% CJK) / 15ch, maxW = DOM one-line width. */
  columns(measured: MeasuredCell[][], box: CellBox): AreaFitColumn[];
}

const MEASURE_CLASS = 'md-table-col-fit-measuring';
const FIT_CLASS = 'md-table-fit';
const CONTENT_WIDTHS = [120, 200, 320];
const GLYPHS = ['中', '日', '本', '語', 'あ', 'ア', '用', '户'];
/** (a) extra row: one cell with several inline code chips (inline-box padding, modelled by the adapter since 7a43c3c). */
const TABLE_CHIP =
  '| Case |\n| --- |\n| Run `npm test`, then `npm run build` and `git commit` before merging to the main branch |\n';

async function installGateA(page: Page): Promise<void> {
  await page.evaluate(
    ({ measureClass, fitClass }) => {
      const debug = (window as unknown as { TableAreaFitDebug: Debug }).TableAreaFitDebug;
      const px = (v: string): number => parseFloat(v) || 0;
      const FIXED = 'img,svg,video,.katex';
      const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
      const gate: GateA = {
        debug,
        box(cell) {
          const cs = getComputedStyle(cell);
          const span = document.createElement('span');
          span.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;top:0;display:inline-block;padding:0;border:0;width:1ch';
          span.style.fontFamily = cs.fontFamily;
          span.style.fontSize = cs.fontSize;
          span.style.fontWeight = cs.fontWeight;
          span.style.fontStyle = cs.fontStyle;
          span.style.letterSpacing = cs.letterSpacing;
          document.body.appendChild(span);
          const chPx = span.getBoundingClientRect().width;
          span.remove();
          return {
            padX: px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth),
            padY: px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth),
            lineH: px(cs.lineHeight),
            chPx,
            font: `${cs.fontFamily} ${cs.fontSize}`,
          };
        },
        measure(table) {
          const measured = debug.measureTableLines(table);
          table.classList.add(measureClass);
          const range = document.createRange();
          const out = Array.from(table.rows).map((row, r) =>
            Array.from(row.cells).map((cell, c) => {
              range.selectNodeContents(cell);
              return { lines: measured[r][c], domOneLineW: range.getBoundingClientRect().width };
            })
          );
          table.classList.remove(measureClass);
          return out;
        },
        modelOneLineW(lines) {
          return Math.max(0, ...lines.segments.map((seg) => seg.reduce((s, u, i) => s + u.w + (i ? u.gap : 0), 0)));
        },
        realLines(cell, lineH) {
          const range = document.createRange();
          const centres: number[] = [];
          const push = (r: DOMRect): void => {
            if (r.width > 0 && r.height > 0) {
              centres.push(r.top + r.height / 2);
            }
          };
          const visit = (n: Node): void => {
            if (n.nodeType === Node.TEXT_NODE) {
              if ((n.textContent ?? '').trim()) {
                range.selectNodeContents(n);
                Array.from(range.getClientRects()).forEach(push);
              }
              return;
            }
            if (n.nodeType !== Node.ELEMENT_NODE) {
              return;
            }
            const el = n as Element;
            // Fixed boxes and atomic inline boxes (e.g. the text-less .md-math-toggle button):
            // one rect per line fragment, since KaTeX itself can wrap between its .base boxes.
            if (el.matches(FIXED) || getComputedStyle(el).display.startsWith('inline-')) {
              Array.from(el.getClientRects()).forEach(push);
              return;
            }
            if (getComputedStyle(el).display === 'none') {
              return;
            }
            n.childNodes.forEach(visit);
          };
          cell.childNodes.forEach(visit);
          centres.sort((a, b) => a - b);
          let lines = 0;
          let start = -Infinity;
          for (const c of centres) {
            if (c - start > lineH / 2) {
              lines++;
              start = c;
            }
          }
          return Math.max(1, lines);
        },
        pin(table, widths) {
          table.classList.add(fitClass);
          table.style.maxWidth = 'none';
          table.style.width = `${widths.reduce((a, b) => a + b, 0)}px`;
          for (const row of Array.from(table.rows)) {
            Array.from(row.cells).forEach((cell, i) => {
              cell.style.boxSizing = 'border-box';
              cell.style.removeProperty('min-width');
              const w = `${widths[i]}px`;
              cell.style.width = w;
              cell.style.maxWidth = w;
            });
          }
        },
        unpin(table) {
          table.classList.remove(fitClass);
          table.style.removeProperty('max-width');
          table.style.removeProperty('width');
          for (const row of Array.from(table.rows)) {
            for (const cell of Array.from(row.cells)) {
              cell.style.removeProperty('width');
              cell.style.removeProperty('max-width');
            }
          }
        },
        columns(measured, box) {
          const colCount = Math.max(...measured.map((r) => r.length));
          return Array.from({ length: colCount }, (_, j) => {
            const cells = measured.map((row) => row[j]?.lines ?? { segments: [], cjkUnits: 0, units: 0 });
            const units = cells.flatMap((c) => c.segments.flat());
            const hardMinW = Math.ceil(Math.max(0, ...units.map((u) => u.w)) + box.padX);
            const maxW = Math.max(hardMinW, Math.ceil(Math.max(0, ...measured.map((row) => row[j]?.domOneLineW ?? 0)) + box.padX));
            const cjk = cells.reduce((s, c) => s + c.cjkUnits, 0);
            const all = cells.reduce((s, c) => s + c.units, 0);
            const readFloorW = clamp(Math.ceil((all > 0 && cjk / all >= 0.5 ? 36 : 30) * box.chPx), hardMinW, maxW);
            const looseFloorW = clamp(Math.ceil(15 * box.chPx), hardMinW, readFloorW);
            return { cells, hardMinW, readFloorW, looseFloorW, maxW };
          });
        },
      };
      (window as unknown as { __gateA: GateA }).__gateA = gate;
    },
    { measureClass: MEASURE_CLASS, fitClass: FIT_CLASS }
  );
}

async function openTable(page: Page, markdown: string, config: Parameters<typeof openEditor>[2] = {}): Promise<void> {
  await openEditor(page, markdown, config);
  await page.locator('#content table').waitFor();
  if (markdown.includes('$')) {
    await page.locator('#content td .katex').first().waitFor();
  }
  await installGateA(page);
}

/** Markdown table + separator + `n` numbered rows in a fixed-width console block. */
function printTable(title: string, header: string[], rows: (string | number)[][]): void {
  const cell = (v: string | number): string => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : v);
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)];
  console.log(`\n${title}\n${lines.join('\n')}`);
}

// ---------------------------------------------------------------- (a) lines

interface LineSummary {
  table: string;
  contentW: number;
  pretty: boolean;
  cells: number;
  exact: number;
  off1: number;
  worse: number;
  simOver: number;
  simUnder: number;
  maxAbs: number;
  /** Cells whose pinned content width missed the requested one by > 0.5 px. */
  pinDrift: number;
  mismatches: string[];
}
interface LineProbe {
  summaries: LineSummary[];
  /** Cells the model wraps at the column's max width (T1.1 review pending 3): cellLineCount at ceil(maxW) − padX > hard lines. */
  overflowCells: string[];
  support: string;
}

async function probeLines(page: Page, name: string, markdown: string, widths: number[] = CONTENT_WIDTHS, prettyModes: boolean[] = [true, false]): Promise<LineProbe> {
  await openTable(page, markdown);
  return page.evaluate(
    ({ name, widths, prettyModes }) => {
      const g = (window as unknown as { __gateA: GateA }).__gateA;
      const table = document.querySelector('#content table') as HTMLTableElement;
      const rows = Array.from(table.rows);
      const box = g.box(table.tBodies[0].rows[0].cells[0]);
      const measured = g.measure(table);
      const overflowCells: string[] = [];
      measured.forEach((row, r) =>
        row.forEach((m, c) => {
          const maxContentW = Math.ceil(m.domOneLineW + box.padX) - box.padX;
          const atMax = g.debug.cellLineCount(m.lines, maxContentW);
          if (atMax > Math.max(1, m.lines.segments.length)) {
            overflowCells.push(`r${r}c${c}: ${atMax} lines at max width (model ${g.modelOneLineW(m.lines).toFixed(1)} vs DOM ${m.domOneLineW.toFixed(1)})`);
          }
        })
      );
      const wrapOff = ['auto', 'wrap'].find((v) => CSS.supports('text-wrap', v)) ?? 'auto';
      const support = `text-wrap: pretty ${CSS.supports('text-wrap', 'pretty') ? 'supported' : 'UNSUPPORTED'}; off = text-wrap: ${wrapOff}`;
      const colCount = Math.max(...rows.map((r) => r.cells.length));
      const summaries: LineSummary[] = [];
      for (const contentW of widths) {
        for (const pretty of prettyModes) {
          g.pin(table, new Array<number>(colCount).fill(contentW + box.padX));
          for (const row of rows) {
            for (const cell of Array.from(row.cells)) {
              cell.style.setProperty('text-wrap', pretty ? 'pretty' : wrapOff);
            }
          }
          const s: LineSummary = { table: name, contentW, pretty, cells: 0, exact: 0, off1: 0, worse: 0, simOver: 0, simUnder: 0, maxAbs: 0, pinDrift: 0, mismatches: [] };
          rows.forEach((row, r) =>
            Array.from(row.cells).forEach((cell, c) => {
              const actualW = cell.getBoundingClientRect().width - box.padX;
              if (Math.abs(actualW - contentW) > 0.5) {
                s.pinDrift++;
              }
              const sim = g.debug.cellLineCount(measured[r][c].lines, actualW);
              const real = g.realLines(cell, box.lineH);
              const d = sim - real;
              s.cells++;
              if (d === 0) {
                s.exact++;
              } else if (Math.abs(d) === 1) {
                s.off1++;
              } else {
                s.worse++;
              }
              if (d > 0) {
                s.simOver++;
              } else if (d < 0) {
                s.simUnder++;
              }
              s.maxAbs = Math.max(s.maxAbs, Math.abs(d));
              if (d !== 0) {
                s.mismatches.push(`r${r}c${c} sim ${sim} real ${real}`);
              }
            })
          );
          summaries.push(s);
          for (const row of rows) {
            for (const cell of Array.from(row.cells)) {
              cell.style.removeProperty('text-wrap');
            }
          }
          g.unpin(table);
        }
      }
      return { summaries, overflowCells, support };
    },
    { name, widths, prettyModes }
  );
}

const GATE_TABLES: [string, string][] = [
  ['#1', TABLE_1],
  ['#4', TABLE_4],
  ['#8b', TABLE_8B],
  ['#20', TABLE_20],
];
const EXTRA_TABLES: [string, string][] = [
  ['chip', TABLE_CHIP],
  ['#8a', TABLE_8A],
];

test.describe('GATE A — area-fit line model vs Chromium', () => {
  test('(a) simulated vs real line count per fixture × content width, with and without text-wrap: pretty', async ({ page }) => {
    test.setTimeout(90_000);
    const all: LineSummary[] = [];
    const notes: string[] = [];
    for (const [name, md] of [...GATE_TABLES, ...EXTRA_TABLES]) {
      const probe = await probeLines(page, name, md);
      all.push(...probe.summaries);
      notes.push(`${name}: ${probe.support}; model wraps at max width: ${probe.overflowCells.length ? probe.overflowCells.join('; ') : 'none'}`);
    }
    printTable(
      '(a) simulated vs real lines (Δ = sim − real; gate rows = #1 #4 #8b #20)',
      ['table', 'contentW', 'pretty', 'cells', 'exact', '|Δ|=1', '|Δ|≥2', 'sim>real', 'sim<real', 'max|Δ|', 'pin drift', 'mismatches'],
      all.map((s) => [s.table, s.contentW, s.pretty ? 'on' : 'off', s.cells, s.exact, s.off1, s.worse, s.simOver, s.simUnder, s.maxAbs, s.pinDrift, s.mismatches.join('; ') || '—'])
    );
    console.log(notes.join('\n'));
    const gateNames = new Set(GATE_TABLES.map(([n]) => n));
    const aggregate = (pretty: boolean): { cells: number; exact: number; maxAbs: number; pinDrift: number } =>
      all
        .filter((s) => gateNames.has(s.table) && s.pretty === pretty)
        .reduce((acc, s) => ({ cells: acc.cells + s.cells, exact: acc.exact + s.exact, maxAbs: Math.max(acc.maxAbs, s.maxAbs), pinDrift: acc.pinDrift + s.pinDrift }), { cells: 0, exact: 0, maxAbs: 0, pinDrift: 0 });
    const on = aggregate(true);
    const off = aggregate(false);
    const verdict = (a: { cells: number; exact: number; maxAbs: number }): string =>
      `${a.exact}/${a.cells} exact = ${((100 * a.exact) / a.cells).toFixed(1)}%, max |Δ| = ${a.maxAbs} → ${a.exact / a.cells >= 0.95 && a.maxAbs <= 1 ? 'green' : 'RED'}`;
    console.log(`GATE A (text-wrap: pretty on, contract 12): ${verdict(on)}\nGATE A (text-wrap: pretty off): ${verdict(off)}`);
    // Positive control: every gate cell really sat at the requested content width (else sim and real both read max-content).
    expect(on.pinDrift).toBe(0);
    expect(on.exact / on.cells).toBeGreaterThanOrEqual(0.95);
    expect(on.maxAbs).toBeLessThanOrEqual(1);
  });

  test('(a2) dense width sweep 96–400 px, text-wrap: pretty on (informational, not a gate criterion)', async ({ page }) => {
    test.setTimeout(90_000);
    const widths = Array.from({ length: 39 }, (_, i) => 96 + 8 * i);
    const rows: (string | number)[][] = [];
    for (const [name, md] of [...GATE_TABLES, ...EXTRA_TABLES]) {
      const probe = await probeLines(page, name, md, widths, [true]);
      const total = probe.summaries.reduce((acc, s) => ({ cells: acc.cells + s.cells, exact: acc.exact + s.exact, off1: acc.off1 + s.off1, worse: acc.worse + s.worse, simOver: acc.simOver + s.simOver, simUnder: acc.simUnder + s.simUnder, maxAbs: Math.max(acc.maxAbs, s.maxAbs) }), { cells: 0, exact: 0, off1: 0, worse: 0, simOver: 0, simUnder: 0, maxAbs: 0 });
      // Which cells miss, at which content widths.
      const byCell = new Map<string, number[]>();
      for (const s of probe.summaries) {
        for (const m of s.mismatches) {
          const key = m.replace(/ sim (\d+) real (\d+)$/, (_, sim: string, real: string) => ` Δ${Number(sim) > Number(real) ? '+' : ''}${Number(sim) - Number(real)}`);
          byCell.set(key, [...(byCell.get(key) ?? []), s.contentW]);
        }
      }
      const cells = [...byCell.entries()].map(([k, ws]) => `${k} @ ${ws.join(',')}`).join('; ');
      rows.push([name, total.cells, total.exact, ((100 * total.exact) / total.cells).toFixed(1) + '%', total.off1, total.worse, total.simOver, total.simUnder, total.maxAbs, cells || '—']);
    }
    printTable('(a2) dense sweep, 39 content widths × every cell (Δ = sim − real)', ['table', 'cell×width', 'exact', 'exact %', '|Δ|=1', '|Δ|≥2', 'sim>real', 'sim<real', 'max|Δ|', 'cells off (r,c @ widths)'], rows);
    expect(rows).toHaveLength(GATE_TABLES.length + EXTRA_TABLES.length);
  });

  test('(b) CJK glyph width vs 1ch in the default and Paper presets', async ({ page }) => {
    const rows: (string | number)[][] = [];
    for (const preset of ['default', 'paper'] as const) {
      await openTable(page, '| A |\n| --- |\n| x |\n', preset === 'paper' ? { readability: { enabled: true, mode: 'paper', fontFamily: '', zen: false } } : {});
      const r = await page.evaluate((glyphs) => {
        const g = (window as unknown as { __gateA: GateA }).__gateA;
        const table = document.querySelector('#content table') as HTMLTableElement;
        const cell = table.tBodies[0].rows[0].cells[0];
        const box = g.box(cell);
        const range = document.createRange();
        const widths = glyphs.map((ch) => {
          cell.textContent = ch;
          range.selectNodeContents(cell);
          return range.getBoundingClientRect().width;
        });
        return { font: box.font, chPx: box.chPx, widths };
      }, GLYPHS);
      const mean = r.widths.reduce((a, b) => a + b, 0) / r.widths.length;
      rows.push([preset, r.font, r.chPx, r.widths.map((w) => w.toFixed(1)).join(' '), mean, mean / r.chPx, (36 * r.chPx) / mean]);
    }
    printTable('(b) CJK glyph px vs 1ch px (glyphs: ' + GLYPHS.join(' ') + ')', ['preset', 'font', '1ch px', 'glyph px', 'mean glyph px', 'glyph / ch', '36ch in glyphs'], rows);
    expect(rows).toHaveLength(2);
  });

  test('(c) solver time on synthetic 20 × 50 (scroll / non-scroll) and measure time on a rendered 20 × 50', async ({ page }) => {
    test.setTimeout(180_000);
    // Rendered 20 × 50: deterministic pseudo-words, 1–12 per cell.
    let seed = 20260929;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const word = (): string => Array.from({ length: 2 + Math.floor(rnd() * 9) }, () => String.fromCharCode(97 + Math.floor(rnd() * 26))).join('');
    const cellText = (): string => Array.from({ length: 1 + Math.floor(rnd() * 12) }, word).join(' ');
    const COLS = 20;
    const ROWS = 50;
    const header = `| ${Array.from({ length: COLS }, (_, c) => `Col ${c + 1}`).join(' | ')} |`;
    const sep = `| ${Array.from({ length: COLS }, () => '---').join(' | ')} |`;
    const body = Array.from({ length: ROWS }, () => `| ${Array.from({ length: COLS }, cellText).join(' | ')} |`).join('\n');
    await openTable(page, `${header}\n${sep}\n${body}\n`);
    const r = await page.evaluate(() => {
      const g = (window as unknown as { __gateA: GateA }).__gateA;
      const table = document.querySelector('#content table') as HTMLTableElement;
      const box = g.box(table.tBodies[0].rows[0].cells[0]);
      const median =(fn: () => void): number => {
        const t: number[] = [];
        for (let i = 0; i < 5; i++) {
          const t0 = performance.now();
          fn();
          t.push(performance.now() - t0);
        }
        return t.sort((a, b) => a - b)[2];
      };
      let measured: MeasuredCell[][] = [];
      const measureMs = median(() => {
        measured = g.measure(table);
      });
      const realCols = g.columns(measured, box);
      const content = document.getElementById('content') as HTMLElement;
      const pcs = getComputedStyle(content);
      const budgetW = content.clientWidth - (parseFloat(pcs.paddingLeft) || 0) - (parseFloat(pcs.paddingRight) || 0);
      const out: (string | number)[][] = [];
      const time = (name: string, cols: AreaFitColumn[], budget: number): void => {
        let res: AreaFitResult | undefined;
        const ms = median(() => {
          res = g.debug.solveAreaFit(cols, { budgetW: budget, padX: box.padX, lineH: box.lineH });
        });
        out.push([name, cols.length, cols[0].cells.length, budget, res!.scroll ? 'scroll' : 'fit', Math.round(res!.widths.reduce((a, b) => a + b, 0)), ms]);
      };
      time('rendered 20×50 @ panel', realCols, budgetW);
      time('rendered 20×50 @ 6000', realCols, 6000);
      // Synthetic (T1.1 bench shape): 1–30 words of 2–12 chars at 7.2 px/char, 4 px gaps, padX 20, floors 231 / 116 (30ch / 15ch at 7.7 px).
      let s = 12345;
      const rnd = (): number => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
      const PAD = 20;
      const synthCell = (): CellLines => {
        const n = 1 + Math.floor(rnd() * 30);
        const seg = Array.from({ length: n }, (_, i) => ({ w: Math.round((2 + rnd() * 10) * 7.2), gap: i ? 4 : 0 }));
        return { segments: [seg], cjkUnits: 0, units: n };
      };
      const synth = (cols: number, rows: number): AreaFitColumn[] =>
        Array.from({ length: cols }, () => {
          const cells = Array.from({ length: rows }, synthCell);
          const hardMinW = Math.max(...cells.flatMap((c) => c.segments[0].map((u) => u.w))) + PAD;
          const maxW = Math.max(...cells.map((c) => g.modelOneLineW(c))) + PAD;
          const readFloorW = Math.min(maxW, Math.max(hardMinW, 231));
          return { cells, hardMinW, readFloorW, looseFloorW: Math.min(readFloorW, Math.max(hardMinW, 116)), maxW };
        });
      const s20 = synth(20, 50);
      time('synthetic 20×50 scroll', s20, 1000);
      time('synthetic 20×50 non-scroll', s20, 6000);
      time('synthetic 8×50 non-scroll', synth(8, 50), 2400);
      time('synthetic 10×500 non-scroll', synth(10, 500), 3000);
      return { measureMs, cells: measured.reduce((n, row) => n + row.length, 0), out, budgetW };
    });
    printTable('(c) solveAreaFit median of 5 runs (ms)', ['case', 'cols', 'rows', 'budgetW', 'branch', 'Σ widths', 'ms'], r.out);
    console.log(`(c) measure time, rendered 20×50 (${r.cells} cells): measureTableLines + Range one-line width, median of 5 = ${r.measureMs.toFixed(1)} ms (widestWordWidth is private to table.ts, not timed); panel budgetW = ${r.budgetW}`);
    expect(r.out).toHaveLength(6);
  });

  test('(d) baseline area of the current fit ladder: #8b and #20 at viewport 800 / 1000 / 1200', async ({ page }) => {
    test.setTimeout(90_000);
    const rows: (string | number)[][] = [];
    for (const [name, md] of [['#8b', TABLE_8B], ['#20', TABLE_20]] as [string, string][]) {
      for (const vw of [800, 1000, 1200]) {
        await page.setViewportSize({ width: vw, height: 700 });
        await openEditor(page, md, { tableFitMode: true });
        await page.locator('#content table').waitFor();
        const snapshot = (): Promise<string> =>
          page.evaluate(() => {
            const t = document.querySelector('#content table') as HTMLTableElement;
            const r = t.getBoundingClientRect();
            return `${t.classList.contains('md-table-fit')}|${Math.round(r.width)}|${Math.round(r.height)}`;
          });
        // The fit pass runs after render and again from the ResizeObserver rAF: wait until two reads 150 ms apart agree.
        // Sentinel: expect.poll calls at once, so the first compare must fail and every later one is 150 ms apart.
        let prev = '';
        await expect
          .poll(
            async () => {
              const cur = await snapshot();
              const same = cur === prev;
              prev = cur;
              return same;
            },
            { timeout: 8000, intervals: [150] }
          )
          .toBe(true);
        const info = await page.evaluate(() => {
          const t = document.querySelector('#content table') as HTMLTableElement;
          const r = t.getBoundingClientRect();
          const content = document.getElementById('content') as HTMLElement;
          return {
            // No fit class + horizontal overflow = the ladder's scroll-at-floor branch.
            branch: t.classList.contains('md-table-fit') ? 'fit' : t.scrollWidth > t.clientWidth + 1 ? 'scroll' : 'natural',
            contentW: content.clientWidth,
            w: r.width,
            h: r.height,
            scrollW: t.scrollWidth,
            colWidths: Array.from(t.rows[0].cells).map((c) => Math.round(c.getBoundingClientRect().width)),
            rowHeights: Array.from(t.rows).map((row) => Math.round(row.getBoundingClientRect().height)),
          };
        });
        rows.push([name, vw, info.contentW, info.branch, info.w, info.h, Math.round(info.w * info.h), info.scrollW, info.colWidths.join(' '), info.rowHeights.join(' ')]);
      }
    }
    printTable('(d) baseline: current fit ladder, fit ON (T1.10 acceptance numbers; area = rect W × H)', ['table', 'viewport', '#content W', 'branch', 'table W', 'table H', 'area px²', 'scrollWidth', 'col widths', 'row heights'], rows);
    expect(rows).toHaveLength(6);
  });

  test('(e) solver rowHeights vs real row heights at the solver widths, viewport 1000', async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1000, height: 700 });
    for (const [name, md] of [['#8b', TABLE_8B], ['#20', TABLE_20]] as [string, string][]) {
      // Fit OFF: the fit ladder leaves the pinned widths alone (no ResizeObserver re-fit).
      await openTable(page, md);
      const r = await page.evaluate(() => {
        const g = (window as unknown as { __gateA: GateA }).__gateA;
        const table = document.querySelector('#content table') as HTMLTableElement;
        const rows = Array.from(table.rows);
        const box = g.box(table.tBodies[0].rows[0].cells[0]);
        const measured = g.measure(table);
        const cols = g.columns(measured, box);
        const content = document.getElementById('content') as HTMLElement;
        const pcs = getComputedStyle(content);
        const budgetW = content.clientWidth - (parseFloat(pcs.paddingLeft) || 0) - (parseFloat(pcs.paddingRight) || 0);
        const res = g.debug.solveAreaFit(cols, { budgetW, padX: box.padX, lineH: box.lineH });
        g.pin(table, res.widths);
        const px = (v: string): number => parseFloat(v) || 0;
        const rowsOut = rows.map((row, r) => {
          const cells = Array.from(row.cells);
          const real = Math.max(
            ...cells.map((cell) => {
              const cs = getComputedStyle(cell);
              return cell.getBoundingClientRect().height - px(cs.paddingTop) - px(cs.paddingBottom) - px(cs.borderTopWidth) - px(cs.borderBottomWidth);
            })
          );
          const realLines = cells.map((cell) => g.realLines(cell, box.lineH));
          const simLines = cells.map((_, c) => g.debug.cellLineCount(measured[r][c].lines, res.widths[c] - box.padX));
          const mismatches = cells.map((_, c) => (simLines[c] === realLines[c] ? '' : `c${c} sim ${simLines[c]} real ${realLines[c]} @ ${res.widths[c] - box.padX}px`)).filter(Boolean);
          return [r, res.rowHeights[r], real, res.rowHeights[r] - real, Math.max(...simLines), Math.max(...realLines), mismatches.join('; ') || '—'];
        });
        const pinDrift = rows.flatMap((row) => Array.from(row.cells).filter((cell, c) => Math.abs(cell.getBoundingClientRect().width - res.widths[c]) > 0.5)).length;
        const rect = table.getBoundingClientRect();
        return {
          budgetW,
          padX: box.padX,
          lineH: box.lineH,
          chPx: box.chPx,
          scroll: res.scroll,
          widths: res.widths,
          cols: cols.map((c) => `${c.hardMinW}/${c.looseFloorW}/${c.readFloorW}/${c.maxW}`),
          rowsOut,
          simH: res.rowHeights.reduce((a, b) => a + b, 0),
          realH: rowsOut.reduce((a, row) => a + (row[2] as number), 0),
          tableW: rect.width,
          tableH: rect.height,
          pinDrift,
        };
      });
      printTable(
        `(e) ${name} @ viewport 1000: budgetW ${r.budgetW}, padX ${r.padX}, lineH ${r.lineH}, 1ch ${r.chPx.toFixed(2)} px; ${r.scroll ? 'SCROLL' : 'fit'}; widths ${r.widths.join(' ')} (Σ ${r.widths.reduce((a, b) => a + b, 0)}); columns hard/loose/read/max: ${r.cols.join(', ')}; table ${r.tableW.toFixed(0)} × ${r.tableH.toFixed(0)} = ${Math.round(r.tableW * r.tableH)} px²; pin drift ${r.pinDrift}`,
        ['row', 'sim H px', 'real content H px', 'Δ px', 'sim lines', 'real lines', 'cells off'],
        r.rowsOut
      );
      console.log(`(e) ${name}: Σ sim H ${r.simH.toFixed(1)} vs Σ real H ${r.realH.toFixed(1)} (Δ ${(r.simH - r.realH).toFixed(1)} px)`);
      expect(r.rowsOut.length).toBeGreaterThan(0);
    }
  });
});
