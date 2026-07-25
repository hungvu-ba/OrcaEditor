#!/usr/bin/env node

/**
 * Guard against the macOS-vs-Windows defect family documented in
 * "Plan/Cross-Environment Defects — Audit.md": the codebase is developed and
 * tested on macOS, so a regression that only breaks on Windows is invisible
 * locally. This checks the invariants that audit proved clean, so future
 * edits can't silently undo them.
 *
 * 1. Keyboard-shortcut handlers must test `metaKey` and `ctrlKey` on the same
 *    line (X-6 class) — one without the other means the shortcut only fires
 *    on one platform.
 * 2. UI strings must not hardcode the '⌘' glyph without a "Ctrl" fallback on
 *    the same line (X-11 class) — the label would lie on Windows/Linux.
 * 3. The round-trip/unit test suite must keep at least one CRLF fixture, one
 *    NFC/NFD fixture, and one Windows-shaped path (drive letter + backslash)
 *    fixture — without these, the defect class in (1)/(2) and their EOL/path
 *    siblings has no automated coverage at all (see the audit's closing note).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WEBVIEW_DIR = path.join(ROOT, 'media/webview');
const TEST_DIR = path.join(ROOT, 'test');

let problems = [];

function webviewTsFiles() {
  return fs
    .readdirSync(WEBVIEW_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(WEBVIEW_DIR, f));
}

function walkTsFiles(dir) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walkTsFiles(abs));
    else if (entry.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
}

// --- Check 1: metaKey/ctrlKey same-line symmetry ---
for (const file of webviewTsFiles()) {
  const rel = path.relative(ROOT, file);
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return;
    const hasMeta = /\bmetaKey\b/.test(line);
    const hasCtrl = /\bctrlKey\b/.test(line);
    if (hasMeta !== hasCtrl) {
      const missing = hasMeta ? 'ctrlKey' : 'metaKey';
      problems.push(`${rel}:${i + 1}  has ${hasMeta ? 'metaKey' : 'ctrlKey'} but no ${missing} on the same line — shortcut only fires on one platform.`);
    }
  });
}

// --- Check 2: hardcoded '⌘' without a "Ctrl" fallback on the same line ---
for (const file of webviewTsFiles()) {
  const rel = path.relative(ROOT, file);
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return;
    if (line.includes('⌘') && !line.includes('Ctrl')) {
      problems.push(`${rel}:${i + 1}  '⌘' glyph with no "Ctrl" fallback on the same line — label is wrong on Windows/Linux.`);
    }
  });
}

// --- Check 3: cross-platform test fixtures still present ---
const testFiles = walkTsFiles(TEST_DIR);
const hasCrlfFixture = testFiles.some((f) => fs.readFileSync(f, 'utf-8').includes('\\r\\n'));
const hasNfdFixture = testFiles.some((f) => /normalize\(\s*['"]NFD['"]\s*\)/.test(fs.readFileSync(f, 'utf-8')));
const hasWindowsPathFixture = testFiles.some((f) => /[A-Za-z]:\\\\/.test(fs.readFileSync(f, 'utf-8')));

if (!hasCrlfFixture) problems.push('test/**  no CRLF ("\\r\\n") fixture found — CRLF-vs-LF regressions (X-2/X-3 class) have no coverage.');
if (!hasNfdFixture) problems.push('test/**  no NFD normalize() fixture found — NFC/NFD filename regressions (X-4/X-5 class) have no coverage.');
if (!hasWindowsPathFixture) problems.push('test/**  no Windows-shaped path (drive letter + backslash) fixture found — Windows path regressions have no coverage.');

if (problems.length) {
  console.error('Cross-platform check FAILED:\n' + problems.map((p) => '  ' + p).join('\n'));
  process.exit(1);
}
console.log('Cross-platform check passed: metaKey/ctrlKey symmetry, ⌘/Ctrl labels, and CRLF/NFD/Windows-path test fixtures all present.');
