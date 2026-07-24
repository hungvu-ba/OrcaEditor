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
import { Runner, renderer, turndown, domino } from './_lib';
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

runner.finish('plantuml');
