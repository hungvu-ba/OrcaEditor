#!/usr/bin/env node
// Chạy tuần tự MỌI file dist/test/roundtrip/*.js (mỗi file = 1 feature, xem
// test/roundtrip/*.ts) và gộp kết quả — dùng bởi `npm run test:roundtrip`.
// Chạy riêng 1 feature: node dist/test/roundtrip/<feature>.js
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'dist', 'test', 'roundtrip');
const srcDir = path.join(__dirname, 'roundtrip');
// dist/ is gitignored and never pruned, so a bundle outlives its source: a
// renamed or deleted feature — and any scratch script someone once built —
// keeps running forever and counts toward the pass total. Require a live .ts
// source so the run reflects test/roundtrip/, not build-output history.
const all = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.js') && !f.endsWith('.js.map'))
  .sort();
const files = all.filter((f) => fs.existsSync(path.join(srcDir, `${path.basename(f, '.js')}.ts`)));
const orphans = all.filter((f) => !files.includes(f));
if (orphans.length) {
  console.log(`Skipping ${orphans.length} stale bundle(s) with no source: ${orphans.join(', ')}`);
}

const failed = [];
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const res = spawnSync('node', [path.join(dir, f)], { stdio: 'inherit' });
  if (res.status !== 0) {
    failed.push(f);
  }
}

console.log(`\n${files.length - failed.length}/${files.length} feature file(s) pass`);
if (failed.length) {
  console.log('FAIL:', failed.join(', '));
  process.exit(1);
}
