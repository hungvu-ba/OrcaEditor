/**
 * Roundtrip — Performance audit L-8: `MarkdownRenderer` memoizes highlight.js and
 * KaTeX output by source text, so a host re-render (undo/redo, external edit) only
 * re-highlights / re-typesets the blocks that changed.
 *
 * Checks:
 *  a) a warm renderer's HTML === a fresh renderer's HTML (the memo is invisible),
 *  b) 50 fences cold = 50 `hljs.highlight` calls; one fence edited = 1 call,
 *  d) the memo is bounded: 501 distinct fences evict the first one.
 * No KaTeX call count: a spy on `katex.renderToString` never sees the plugin's own
 * `require('katex')` instance, so the math memo is covered by (a) only.
 * Prints the SAMPLE1.md one-line-edit re-render time, cold vs warm renderer.
 */
import * as fs from 'fs';
import * as path from 'path';
import hljs from 'highlight.js/lib/common';
import { MarkdownRenderer } from '../../media/webview/pipeline';
import { Runner, firstDiff } from './_lib';

const runner = new Runner();
const fresh = (): MarkdownRenderer => new MarkdownRenderer({ breaks: false, linkify: true });

/** Replaces `obj[key]` with a counting wrapper; returns the count reader and the restore. */
function spy<T extends object>(obj: T, key: keyof T): { calls: () => number; reset: () => void; restore: () => void } {
  const original = obj[key] as unknown as (...args: unknown[]) => unknown;
  let calls = 0;
  (obj as Record<keyof T, unknown>)[key] = (...args: unknown[]) => {
    calls++;
    return original.apply(obj, args);
  };
  return {
    calls: () => calls,
    reset: () => (calls = 0),
    restore: () => ((obj as Record<keyof T, unknown>)[key] = original),
  };
}

const fence = (i: number): string => '```ts\nconst v' + i + ' = ' + i + ';\n```';
const mathBlock = (i: number): string => `$$\nx^{${i}} + y_{${i}}\n$$`;
const fences = (n: number, edited = -1): string =>
  Array.from({ length: n }, (_, i) => (i === edited ? fence(i).replace(' = ', ' = 1 + ') : fence(i))).join('\n\n') + '\n';
const mathDoc = (n: number, edited = -1): string =>
  Array.from({ length: n }, (_, i) => (i === edited ? mathBlock(i).replace('+ y', '- y') : mathBlock(i))).join('\n\n') + '\n';

const sample1 = fs.readFileSync(path.join(process.cwd(), 'Sample', 'SAMPLE1.md'), 'utf8');
const mixed = `# Mixed\n\n${fences(50)}\nInline $a^2$ math.\n\n${mathDoc(20)}`;

// (a) warm === fresh
for (const [name, md] of [
  ['SAMPLE1.md', sample1],
  ['50 fences + 20 $$', mixed],
] as const) {
  const warm = fresh();
  warm.render(md);
  const warmHtml = warm.render(md).html;
  const freshHtml = fresh().render(md).html;
  runner.check(`[${name}] warm renderer html === fresh renderer html`, warmHtml === freshHtml, firstDiff(warmHtml, freshHtml));
}

// (b) highlight.js calls
{
  const hl = spy(hljs, 'highlight');
  const r = fresh();
  r.render(fences(50));
  runner.check('50 fences cold = 50 hljs.highlight calls', hl.calls() === 50, `  calls: ${hl.calls()}`);
  hl.reset();
  const edited = fences(50, 17);
  const html = r.render(edited).html;
  runner.check('one fence edited = 1 hljs.highlight call', hl.calls() === 1, `  calls: ${hl.calls()}`);
  hl.restore();
  runner.check('...and the edit is in the html', html === fresh().render(edited).html);
}

// (d) bound holds
{
  const hl = spy(hljs, 'highlight');
  const r = fresh();
  r.render(fences(501));
  hl.reset();
  r.render(fence(0) + '\n');
  runner.check('after 501 distinct fences the first is re-highlighted (evicted)', hl.calls() === 1, `  calls: ${hl.calls()}`);
  hl.reset();
  r.render(fence(500) + '\n');
  runner.check('...while the newest is still cached', hl.calls() === 0, `  calls: ${hl.calls()}`);
  hl.restore();
}

// ms: one-line edit re-render, cold renderer (before) vs warm renderer (after)
function timeEdit(name: string, md: string, edited: string): void {
  const runs = 30;
  fresh().render(md); // compile hljs languages once, outside both timings
  let cold = 0;
  for (let i = 0; i < runs; i++) {
    const r = fresh();
    const t = performance.now();
    r.render(edited);
    cold += performance.now() - t;
  }
  let warm = 0;
  for (let i = 0; i < runs; i++) {
    const r = fresh();
    r.render(md);
    const t = performance.now();
    r.render(edited);
    warm += performance.now() - t;
  }
  console.log(`MS    [${name}] one-line edit re-render: cold ${(cold / runs).toFixed(2)} ms -> warm ${(warm / runs).toFixed(2)} ms`);
}
const sampleLines = sample1.split('\n');
const editLine = sampleLines.findIndex((line) => /^[A-Za-z]/.test(line));
timeEdit(
  'SAMPLE1.md',
  sample1,
  sampleLines.map((line, i) => (i === editLine ? line + ' edited' : line)).join('\n')
);
timeEdit('50 fences + 20 $$', mixed, mixed.replace('# Mixed', '# Mixed edited'));

runner.finish('render-memo');
