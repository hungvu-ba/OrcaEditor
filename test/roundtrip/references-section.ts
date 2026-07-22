/**
 * Req 20 US-20.5 — src/references-section.ts (pure scan + merge engine).
 *
 * These are NOT render→serialize round-trips: the module is pure string ops, so
 * we drive planReferences/renderReferences/normalizeHrefKey directly (the
 * DOM/host has no part in the scan). Covers: create, merge-preserve,
 * append-missing-in-place, present-by-path, self-reference exclusion, code
 * fence/span exclusion, no-op, image exclusion, external-scheme exclusion,
 * Windows drive-letter, #anchor consolidation, and the ⚠️ broken prefix.
 *
 * Run standalone: npm run test:roundtrip:references-section
 */
import { Runner } from './_lib';
import { normalizeHrefKey, planReferences, renderReferences } from '../../src/references-section';

const runner = new Runner();

/** Convenience: build the plan and render with a given broken-key set. */
function render(text: string, brokenKeys: string[] = []): string | null {
  const plan = planReferences(text);
  return renderReferences(text, plan, new Set(brokenKeys));
}

// ---- normalizeHrefKey (single source of truth for dedup + nav) ----
runner.eq('key: strips ./ prefix', normalizeHrefKey('./a.md'), 'a.md');
runner.eq('key: bare path unchanged', normalizeHrefKey('a.md'), 'a.md');
runner.eq('key: resolves ..', normalizeHrefKey('../dir/../dir2/x.md'), '../dir2/x.md');
runner.eq('key: strips #fragment', normalizeHrefKey('a.md#heading'), 'a.md');
runner.eq('key: strips ?query then #fragment', normalizeHrefKey('a.md?v=1#h'), 'a.md');
runner.eq('key: decodes %20', normalizeHrefKey('my%20file.md'), 'my file.md');
runner.eq('key: Windows drive lower-cased, kept as path', normalizeHrefKey('C:\\dir\\x.md'), 'c:/dir/x.md');
runner.eq('key: two anchors of one file collapse', normalizeHrefKey('path.md#a') === normalizeHrefKey('path.md#b'), true);
runner.eq('key: ./a.md and a.md agree', normalizeHrefKey('./a.md') === normalizeHrefKey('a.md'), true);

// ---- create: no section → appended at EOD, exact format + single trailing newline ----
{
  const md = 'See [Guide](guide.md) for details.\n';
  const out = render(md);
  runner.eq('create: appends a References section', out, 'See [Guide](guide.md) for details.\n\n## References\n\n- [Guide](guide.md)\n');
}

// ---- create from empty-ish body: exactly one trailing newline, no glued text ----
{
  const md = '[A](a.md) and [B](b.md)';
  const out = render(md);
  runner.eq('create: two links, first-occurrence order', out, '[A](a.md) and [B](b.md)\n\n## References\n\n- [A](a.md)\n- [B](b.md)\n');
}

// ---- merge-preserve: existing hand-formatted entry left byte-identical, only missing appended ----
{
  const md = [
    'Body links [A](a.md) and [B](b.md).',
    '',
    '## References',
    '',
    '* [A](a.md) — my own note, custom bullet',
    '',
  ].join('\n');
  const out = render(md);
  // The `* [A]...` line is untouched (still present-by-key); only B is appended, in place after it.
  const expected = [
    'Body links [A](a.md) and [B](b.md).',
    '',
    '## References',
    '',
    '* [A](a.md) — my own note, custom bullet',
    '- [B](b.md)',
    '',
  ].join('\n');
  runner.eq('merge: preserves custom entry, appends only missing', out, expected);
}

// ---- append-missing in place before a following heading ----
{
  const md = [
    '[A](a.md) [B](b.md)',
    '',
    '## References',
    '',
    '- [A](a.md)',
    '',
    '## Appendix',
    '',
    'tail',
  ].join('\n');
  const out = render(md);
  const expected = [
    '[A](a.md) [B](b.md)',
    '',
    '## References',
    '',
    '- [A](a.md)',
    '- [B](b.md)',
    '',
    '## Appendix',
    '',
    'tail',
  ].join('\n');
  runner.eq('append: inserts before the next heading, in place', out, expected);
}

// ---- present-by-path: ./a.md body vs a.md existing → not re-added ----
{
  const md = ['[A](./a.md)', '', '## References', '', '- [A](a.md)', ''].join('\n');
  const out = render(md);
  runner.eq('present-by-path: ./a.md already present as a.md → no-op', out, null);
}

// ---- self-reference: link only inside References section is not a body occurrence ----
{
  const md = ['# Title', '', '## References', '', '- [Only Here](only.md)', ''].join('\n');
  const out = render(md);
  runner.eq('self-ref: section-only link is not gathered as body', out, null);
}

// ---- code-fence + inline code span: links inside are not gathered ----
{
  const md = ['```', '[X](x.md)', '```', '', 'Inline `[Y](y.md)` sample.'].join('\n');
  const out = render(md);
  runner.eq('code: fenced + inline-span links are ignored', out, null);
}

// ---- no-op: no in-scope links at all ----
{
  runner.eq('no-op: plain prose', render('Just prose, no links.\n'), null);
}

// ---- image exclusion, incl. the inner image of a nested link ----
{
  const md = '![alt](pic.png) and [![thumb](pic.png)](real.md)';
  const out = render(md);
  // Only the outer file.md link is gathered; its display (the inner image) has
  // its brackets escaped so the emitted entry line is never malformed (AC).
  runner.eq('image: standalone image + nested inner image excluded, only outer file.md', out,
    '![alt](pic.png) and [![thumb](pic.png)](real.md)\n\n## References\n\n- [!\\[thumb\\](pic.png)](real.md)\n');
}

// ---- external-scheme exclusion (http/mailto/caption) ----
{
  const md = '[web](https://x.com) [mail](mailto:a@b.c) [ent](caption:foo) [ok](local.md)';
  const out = render(md);
  runner.eq('external: only the local link is gathered', out,
    '[web](https://x.com) [mail](mailto:a@b.c) [ent](caption:foo) [ok](local.md)\n\n## References\n\n- [ok](local.md)\n');
}

// ---- Windows drive-letter treated as local ----
{
  const md = '[win](C:/notes/x.md)';
  const out = render(md);
  runner.eq('windows: drive-letter path is local, gathered', out,
    '[win](C:/notes/x.md)\n\n## References\n\n- [win](C:/notes/x.md)\n');
}

// ---- #anchor consolidation: two anchors of one file → one entry (first display/href) ----
{
  const md = '[Sec A](doc.md#a) then [Sec B](doc.md#b)';
  const out = render(md);
  runner.eq('anchors: collapse to one entry, first occurrence wins', out,
    '[Sec A](doc.md#a) then [Sec B](doc.md#b)\n\n## References\n\n- [Sec A](doc.md#a)\n');
}

// ---- pure #heading anchor and empty target excluded ----
{
  const md = '[jump](#section) and [empty]()';
  runner.eq('excluded: pure #anchor and empty target', render(md), null);
}

// ---- ⚠️ prefix when a candidate key is in brokenKeys ----
{
  const md = '[Gone](missing.md) [Here](here.md)';
  const plan = planReferences(md);
  const out = renderReferences(md, plan, new Set([normalizeHrefKey('missing.md')]));
  runner.eq('broken: ⚠️ prefixes only the missing entry', out,
    '[Gone](missing.md) [Here](here.md)\n\n## References\n\n- ⚠️ [Gone](missing.md)\n- [Here](here.md)\n');
}

// ---- href with space is <>-wrapped; display with ] is escaped ----
{
  const md = '[a [b] c](my file.md)';
  const out = render(md);
  // Both brackets in the display are escaped (balanced, never-malformed line);
  // the space-bearing href is <>-wrapped.
  runner.eq('escape: display brackets escaped, spaced href <>-wrapped', out,
    '[a [b] c](my file.md)\n\n## References\n\n- [a \\[b\\] c](<my file.md>)\n');
}

// ---- References heading inside a code fence is NOT a section ----
{
  const md = ['```', '## References', '```', '', '[A](a.md)'].join('\n');
  const out = render(md);
  runner.eq('fence: ## References inside a fence is not the section → creates one', out,
    '```\n## References\n```\n\n[A](a.md)\n\n## References\n\n- [A](a.md)\n');
}

runner.finish('references-section');
