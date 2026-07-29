/**
 * Feature: US-2.8 — PlantUML diagram frames. postProcessPlantumlDom wraps a
 * ```plantuml fence in the same chart⇄source card as Mermaid; the toolbar and
 * the chart container are CHROME, so turndown must serialize the frame back to
 * the original fence with nothing leaking in and nothing dropped.
 *
 * DOM-outcome tests only (the SVG engine needs a real browser and is covered by
 * test/webview/plantuml.spec.ts instead).
 *
 * Chạy riêng: npm run test:roundtrip:plantuml
 */
import { Runner, renderer, turndown, domino, COMPLEX_CELL } from './_lib';
import {
  postProcessMermaidDom,
  postProcessPlantumlDom,
  postProcessCodeHeaders,
  prepareDomForSerialize,
  normalizeMarkdown,
} from '../../media/webview/pipeline';

const runner = new Runner();

/** Render markdown then run the real post-process passes (mirrors main.ts order). */
function inject(mdSrc: string): { root: Element; doc: Document } {
  const html = renderer.render(mdSrc).html;
  const doc = domino.createDocument(`<div id="content">${html}</div>`, true);
  const root = doc.getElementById('content');
  if (!root) {
    throw new Error('no root');
  }
  postProcessMermaidDom(root, doc);
  postProcessPlantumlDom(root, doc);
  postProcessCodeHeaders(root, doc);
  return { root, doc };
}

function serialize(root: Element, doc: Document): string {
  prepareDomForSerialize(root, doc);
  return normalizeMarkdown(turndown.turndown(root as HTMLElement));
}

const SIMPLE = '```plantuml\n@startuml\nAlice -> Bob : Hello\n@enduml\n```\n';

// Wrapping: the fence becomes a frame with toolbar, chart container and source.
{
  const { root } = inject(SIMPLE);
  const wrapper = root.querySelector('.md-plantuml');
  runner.check('```plantuml wrapped into .md-plantuml', !!wrapper);
  runner.check('starts in chart view', wrapper?.getAttribute('data-plantuml-view') === 'chart');
  runner.check('has toggle + zoom buttons', !!root.querySelector('.md-plantuml-toggle') && !!root.querySelector('.md-plantuml-zoom'));
  runner.check('source <pre> re-homed inside the frame', !!root.querySelector('.md-plantuml .md-plantuml-source code'));
  runner.check(
    'plantuml source block gets no code header',
    root.querySelectorAll('.md-code-header').length === 0
  );
}

// Round-trip: frame serializes back to the original fence, byte for byte.
{
  const { root, doc } = inject(SIMPLE);
  const md = serialize(root, doc);
  runner.check(
    'round-trip returns the original ```plantuml fence',
    md === '```plantuml\n@startuml\nAlice -> Bob : Hello\n@enduml\n```\n',
    `  nhận: ${JSON.stringify(md)}`
  );
}

// Chrome must never leak into the .md.
{
  const { root, doc } = inject(SIMPLE);
  const md = serialize(root, doc);
  runner.check(
    'no toolbar/placeholder text leaks into markdown',
    !md.includes('View source') && !md.includes('Zoom') && !md.includes('Rendering PlantUML'),
    `  nhận: ${JSON.stringify(md)}`
  );
}

// A rendered SVG sitting in the chart container is presentation, not content:
// serialize reads the source <pre> only, so the SVG must not reach the .md.
{
  const { root, doc } = inject(SIMPLE);
  const chart = root.querySelector('.md-plantuml-chart');
  if (!chart) {
    throw new Error('no chart container');
  }
  chart.innerHTML = '<svg><text>rendered</text></svg>';
  const md = serialize(root, doc);
  runner.check(
    'rendered SVG in the chart container is not serialized',
    !md.includes('svg') && !md.includes('rendered') && md.includes('Alice -> Bob : Hello'),
    `  nhận: ${JSON.stringify(md)}`
  );
}

// Code view is just a different presentation of the same block — same output.
{
  const { root, doc } = inject(SIMPLE);
  root.querySelector('.md-plantuml')?.setAttribute('data-plantuml-view', 'code');
  const md = serialize(root, doc);
  runner.check(
    'serializes identically in code view',
    md === '```plantuml\n@startuml\nAlice -> Bob : Hello\n@enduml\n```\n',
    `  nhận: ${JSON.stringify(md)}`
  );
}

// Backtick-bearing source must get a longer fence so it cannot close early.
{
  const { root, doc } = inject('```` plantuml\n@startuml\nnote: ``` inside\n@enduml\n````\n');
  const md = serialize(root, doc);
  runner.check(
    'source containing ``` gets a longer fence',
    md.startsWith('````plantuml') && md.trimEnd().endsWith('````'),
    `  nhận: ${JSON.stringify(md)}`
  );
}

// Mermaid and PlantUML frames coexist without either pass claiming the other's block.
{
  const { root, doc } = inject('```mermaid\ngraph TD; A-->B;\n```\n\n' + SIMPLE);
  runner.check('one mermaid frame', root.querySelectorAll('.md-mermaid').length === 1);
  runner.check('one plantuml frame', root.querySelectorAll('.md-plantuml').length === 1);
  const md = serialize(root, doc);
  runner.check(
    'both fences round-trip, each keeping its own language tag',
    md.includes('```mermaid\ngraph TD; A-->B;\n```') && md.includes('```plantuml\n@startuml'),
    `  nhận: ${JSON.stringify(md)}`
  );
}

// US-23.22 deferred item 1 (fixed 2026-07-28): a frame inside a table that needs
// HTML serialization (`td li li` → complexTableAsHtml) is emitted through
// outerHTML, where the `plantumlDiagram` rule never runs — the whole frame
// (toolbar, chart container, `md-plantuml-error` on a failed render, rendered
// SVG) used to land in the user's `.md`. cloneAndStrip now rebuilds the fence.
{
  const html = renderer.render(SIMPLE).html;
  const doc = domino.createDocument(
    '<div id="content"><table><thead><tr><th>A</th></tr></thead><tbody><tr>' +
      `<td>${html}</td>${COMPLEX_CELL}</tr></tbody></table></div>`,
    true
  );
  const root = doc.getElementById('content');
  if (!root) {
    throw new Error('no root');
  }
  postProcessPlantumlDom(root, doc);
  runner.check('raw-HTML: fixture really carries a frame in the cell', !!root.querySelector('.md-plantuml'));
  const md = serialize(root, doc);
  runner.check(
    'raw-HTML: the table really took the raw-HTML path (complexTableAsHtml)',
    md.trimStart().startsWith('<table'),
    `  got: ${JSON.stringify(md)}`
  );
  runner.check(
    'raw-HTML: a frame in a table cell serializes back to its source <pre>, no class/chrome leak',
    // Restored to the source <pre> ELEMENT, not fence text: turndown's own
    // whitespace collapse would turn a text-node fence's newlines into spaces on
    // the NEXT save and destroy the diagram. This is byte-identical to what
    // markdown-it emits for the fence, so the next render re-wraps a real frame.
    // `Alice -> Bob` is text, so `>` comes back HTML-escaped — the browser
    // decodes it on that render.
    md.includes(
      '<pre><code class="language-plantuml">@startuml\nAlice -&gt; Bob : Hello\n@enduml\n</code></pre>'
    ) &&
      !md.includes('md-plantuml') &&
      !md.includes('contenteditable'),
    `  got: ${JSON.stringify(md)}`
  );
  const md2 = (() => {
    const d2 = domino.createDocument(`<div id="content">${renderer.render(md).html}</div>`, true);
    const r2 = d2.getElementById('content');
    if (!r2) {
      throw new Error('no root');
    }
    postProcessPlantumlDom(r2, d2);
    return serialize(r2, d2);
  })();
  runner.check('raw-HTML: stable on a 2nd pass', md2 === md, `  md2: ${JSON.stringify(md2)}\n  md1: ${JSON.stringify(md)}`);
}

// A BLANK LINE inside the diagram source is the shape that would break the
// emitted HTML block — markdown-it ends an html_block at the first blank line,
// which would leave the <pre>/<td>/<table> unclosed and let the browser fix them
// up arbitrarily, mangling the cell a little more on every save. `collapseBlankLines`
// is what prevents it (blank line -> `\n&#10;`, decoded back to a blank line on
// render). The case above deliberately has no blank line, so it proves nothing
// here; pinned separately (US-23.22 review, edge raised by the blind hunter).
{
  const BLANKY = '```plantuml\n@startuml\n\nAlice -> Bob : Hello\n\n@enduml\n```\n';
  /** Serialize `innerHtml` as-is — pass 1 wraps the fence in a complex table, pass 2 must NOT re-wrap. */
  const serializeInner = (innerHtml: string): string => {
    const doc = domino.createDocument(`<div id="content">${innerHtml}</div>`, true);
    const root = doc.getElementById('content');
    if (!root) {
      throw new Error('no root');
    }
    postProcessPlantumlDom(root, doc);
    return serialize(root, doc);
  };
  const md = serializeInner(
    '<table><thead><tr><th>A</th></tr></thead><tbody><tr>' +
      `<td>${renderer.render(BLANKY).html}</td>${COMPLEX_CELL}</tr></tbody></table>`
  );
  runner.check(
    'raw-HTML: a blank line in the source does NOT cut the html_block (becomes &#10;)',
    !/\n[ \t]*\n/.test(md.trim()) && md.includes('&#10;'),
    `  got: ${JSON.stringify(md)}`
  );
  runner.check(
    'raw-HTML: a source with blank lines survives intact',
    md.includes('@startuml') && md.includes('Alice') && md.includes('@enduml'),
    `  got: ${JSON.stringify(md)}`
  );
  const md2 = serializeInner(renderer.render(md).html);
  runner.check(
    'raw-HTML: a source with blank lines is stable on a 2nd pass',
    md2 === md,
    `  md2: ${JSON.stringify(md2)}\n  md1: ${JSON.stringify(md)}`
  );
}

runner.finish('plantuml');
