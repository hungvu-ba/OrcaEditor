/**
 * Feature: Table column resize (US-6.10). DOM-outcome tests: a locked table carries
 * inline width/min-width/max-width/box-sizing on every pinned cell (applyLockedWidths);
 * none of it may reach the .md on either serialization path, and the result must be
 * stable on a second round trip.
 *
 * Run alone: node esbuild.js --test && node dist/test/roundtrip/table-col-resize.js
 */
import { Runner, serializeHtml, renderer } from './_lib';

const runner = new Runner();

interface DomCase {
  name: string;
  html: string;
  expect: (md: string) => boolean;
}

const pin = (px: number) => `style="box-sizing: border-box; width: ${px}px; min-width: ${px}px; max-width: ${px}px;"`;

const noLeak = (md: string) =>
  !md.includes('style') && !md.includes('width') && !md.includes('box-sizing');

const domCases: DomCase[] = [
  {
    name: 'US-6.10: locked pipe table (pinned + unpinned column) → clean pipe, no style leak',
    html:
      `<table><thead><tr><th ${pin(120)}>A</th><th ${pin(80)}>B</th><th>C</th></tr></thead>` +
      `<tbody><tr><td ${pin(120)}>1</td><td ${pin(80)}>2</td><td>3</td></tr></tbody></table>`,
    expect: (md) => md.includes('| A | B | C |') && md.includes('| 1 | 2 | 3 |') && noLeak(md),
  },
  {
    name: 'US-6.10: locked HTML-path table (nested list in a cell) → raw HTML, no style leak',
    html:
      `<table><thead><tr><th ${pin(150)}>Col</th><th ${pin(90)}>Note</th></tr></thead>` +
      `<tbody><tr><td ${pin(150)}><ul><li>parent<ul><li>child 1.1</li></ul></li></ul></td>` +
      `<td ${pin(90)}>x</td></tr></tbody></table>`,
    expect: (md) => md.trimStart().startsWith('<table') && md.includes('child 1.1') && noLeak(md),
  },
];

for (const c of domCases) {
  let ok = true;
  const problems: string[] = [];
  try {
    const md = serializeHtml(c.html);
    if (!c.expect(md)) {
      ok = false;
      problems.push(`Unexpected result: ${JSON.stringify(md)}`);
    }
    const md2 = serializeHtml(renderer.render(md).html);
    if (md2 !== md) {
      ok = false;
      problems.push(`Not stable: md=${JSON.stringify(md)} md2=${JSON.stringify(md2)}`);
    }
  } catch (e) {
    ok = false;
    problems.push(`Exception: ${(e as Error).stack}`);
  }
  runner.check(c.name, ok, problems.join('\n'));
}

runner.finish('table-col-resize');
