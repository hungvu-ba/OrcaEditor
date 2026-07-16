#!/usr/bin/env node
// Chạy tuần tự MỌI file dist/test/roundtrip/*.js (mỗi file = 1 feature, xem
// test/roundtrip/*.ts) và gộp kết quả — dùng bởi `npm run test:roundtrip`.
// Chạy riêng 1 feature: node dist/test/roundtrip/<feature>.js
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'dist', 'test', 'roundtrip');
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.js') && !f.endsWith('.js.map'))
  .sort();

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
