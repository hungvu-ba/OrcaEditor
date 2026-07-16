/**
 * Feature: Render Markdown (HLR mục 2) + Sync & Save round-trip (HLR mục 12).
 * Với mỗi fixture trong test/fixtures/*.md: render(md) → html1, serialize(html1)
 * → md2 (turndown, giống webview), render(md2) → html2 → PASS nếu html1≡html2
 * (chuẩn hóa whitespace ngoài <pre>) và serializer ổn định (serialize(html2)===md2).
 *
 * Chạy riêng: npm run test:roundtrip:rendering
 */
import * as fs from 'fs';
import * as path from 'path';
import { Runner, checkRoundtrip } from './_lib';

const fixturesDir = path.join(__dirname, '..', '..', '..', 'test', 'fixtures');
const runner = new Runner();

const files = fs
  .readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.md'))
  .sort();

if (files.length === 0) {
  console.error('No fixtures found in', fixturesDir);
  process.exit(1);
}

for (const file of files) {
  const md = fs.readFileSync(path.join(fixturesDir, file), 'utf8');
  const { ok, problems } = checkRoundtrip(md);
  runner.check(file, ok, problems.join('\n'));
}

runner.finish('rendering');
