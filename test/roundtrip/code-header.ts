/**
 * Feature: Document Blocks item 8 — per-code-block header (language label + Copy
 * button) injected by postProcessCodeHeaders (dom-postprocess.ts). The header is
 * CHROME, not markdown content: it lives inside <pre> before <code>, so turndown
 * must serialize the block back to its original fence with NO header leakage.
 * Also verifies the pass is idempotent, skips mermaid source blocks, and labels
 * unlabeled fences "Code".
 *
 * Chạy riêng: npm run test:roundtrip:code-header
 */
import { Runner, renderer, turndown, domino } from './_lib';
import {
  postProcessMermaidDom,
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
  postProcessCodeHeaders(root, doc);
  return { root, doc };
}

// Serialize safety: the injected header must not reach the .md.
{
  const { root, doc } = inject('```js\nconst a = 1;\n```\n');
  runner.check('header injected inside <pre>', root.querySelectorAll('.md-code-header').length === 1);
  prepareDomForSerialize(root, doc);
  const md = normalizeMarkdown(turndown.turndown(root as HTMLElement));
  runner.check(
    'serialize ignores the header (no chrome leakage)',
    md.includes('```js') && md.includes('const a = 1;') && !md.includes('Copy') && !md.includes('JavaScript'),
    `  nhận: ${JSON.stringify(md)}`
  );
}

// Idempotent: a second pass must not double-inject.
{
  const { root, doc } = inject('```py\nx = 1\n```\n');
  postProcessCodeHeaders(root, doc);
  runner.check('idempotent — one header after two passes', root.querySelectorAll('.md-code-header').length === 1);
  runner.check('label reads the language display name', root.querySelector('.md-code-lang')?.textContent === 'Python');
}

// Mermaid source block must NOT get a code header.
{
  const { root } = inject('```mermaid\ngraph TD; A-->B;\n```\n');
  runner.check('mermaid source block gets no code header', root.querySelectorAll('.md-code-header').length === 0);
}

// Unlabeled fence still gets a header, labeled "Code".
{
  const { root } = inject('```\nplain text\n```\n');
  runner.check('unlabeled fence → header labeled "Code"', root.querySelector('.md-code-lang')?.textContent === 'Code');
}

// Unknown language → capitalized raw token (fallback branch).
{
  const { root } = inject('```rust\nfn main() {}\n```\n');
  runner.check('unknown lang → capitalized token', root.querySelector('.md-code-lang')?.textContent === 'Rust');
}

// US-4.28: switching a block's language = rewriting its <code> `language-*`
// class (setCodeBlockLanguage in toolbar.ts). turndown reads ONLY that class, so
// the emitted fence info-string must follow the switch, with no leftover token.
{
  const { root, doc } = inject('```js\nconst a = 1;\n```\n');
  const code = root.querySelector('pre > code');
  if (!code) {
    throw new Error('no code');
  }
  // Mirror the serialization-relevant effect of the switch: exactly one language-*.
  for (const c of Array.from(code.classList)) {
    if (c.startsWith('language-')) {
      code.classList.remove(c);
    }
  }
  code.classList.add('language-python');
  prepareDomForSerialize(root, doc);
  const md = normalizeMarkdown(turndown.turndown(root as HTMLElement));
  runner.check(
    'language switch → fence follows the class (```python, no ```js, single fence pair)',
    md.includes('```python') && !md.includes('```js') && md.match(/```/g)?.length === 2,
    `  nhận: ${JSON.stringify(md)}`
  );
}

runner.finish('code-header');
