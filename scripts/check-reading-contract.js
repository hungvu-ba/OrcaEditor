#!/usr/bin/env node

/**
 * Verify Reading Mode contract completeness.
 *
 * Collects --rp-*, --reading-*, --reading-ui-* keys from the :root contract
 * in media/markdown.css, then asserts that each body.reading-palette-* block
 * and each #content.reading-preset-* block declares the full key sets.
 *
 * Exits non-zero if any key from the :root contract is missing from a palette/preset block.
 */

const fs = require('fs');
const path = require('path');

// Read markdown.css
const markdownCssPath = path.join(__dirname, '../media/markdown.css');
const css = fs.readFileSync(markdownCssPath, 'utf-8');

/**
 * Extract keys from a CSS block.
 * Matches `--key-name:` within the block.
 */
function extractKeys(blockContent) {
  const keyRegex = /--([a-z-]+)\s*:/gi;
  const keys = new Set();
  let match;
  while ((match = keyRegex.exec(blockContent)) !== null) {
    keys.add(`--${match[1].toLowerCase()}`);
  }
  return keys;
}

/**
 * Find the :root block in markdown.css (first one, not editor.css ones).
 * Assumes it's a single :root block in markdown.css around line 14.
 */
function extractRootContract(css) {
  // Find :root { ... }
  const rootRegex = /:root\s*\{([^}]*)\}/s;
  const match = css.match(rootRegex);
  if (!match) {
    console.error('ERROR: Could not find :root block in markdown.css');
    process.exit(1);
  }
  const rootContent = match[1];
  return extractKeys(rootContent);
}

/**
 * Find all body.reading-palette-* blocks.
 */
function extractPaletteBlocks(css) {
  const paletteRegex = /body\.reading-palette-([a-zA-Z]+)\s*\{([^}]*)\}/gs;
  const blocks = {};
  let match;
  while ((match = paletteRegex.exec(css)) !== null) {
    const paletteName = match[1];
    const content = match[2];
    blocks[paletteName] = extractKeys(content);
  }
  return blocks;
}

/**
 * Find all #content.reading-preset-* blocks.
 */
function extractPresetBlocks(css) {
  const presetRegex = /#content\.reading-preset-([a-zA-Z]+)\s*\{([^}]*)\}/gs;
  const blocks = {};
  let match;
  while ((match = presetRegex.exec(css)) !== null) {
    const presetName = match[1];
    const content = match[2];
    blocks[presetName] = extractKeys(content);
  }
  return blocks;
}

/**
 * Filter contract keys by prefix.
 */
function filterByPrefix(keys, prefix) {
  return new Set([...keys].filter(k => k.startsWith(prefix)));
}

// Extract all data
const rootContract = extractRootContract(css);
const paletteBlocks = extractPaletteBlocks(css);
const presetBlocks = extractPresetBlocks(css);

// Split contract by type
const rpContract = filterByPrefix(rootContract, '--rp-');
const readingContract = filterByPrefix(rootContract, '--reading-');

// Exclude --reading-ui-* from preset content checks.
// Chrome-text tokens (--reading-ui-*) cascade from body-scoped selectors, not preset blocks,
// because elements that consume them (e.g. #toc-panel) are siblings of #content, not children.
const readingContentContract = new Set(
  [...readingContract].filter(k => !k.startsWith('--reading-ui-'))
);

let hasErrors = false;

// Check palette blocks (should have all --rp-* keys)
console.log('Checking body.reading-palette-* blocks...');
for (const [paletteName, paletteKeys] of Object.entries(paletteBlocks)) {
  const missingRp = [...rpContract].filter(k => !paletteKeys.has(k));
  if (missingRp.length > 0) {
    console.log(`  MISSING in body.reading-palette-${paletteName}: ${missingRp.join(', ')}`);
    hasErrors = true;
  }
}

// Check preset blocks (should have all --reading-* content keys, excluding chrome tokens)
console.log('Checking #content.reading-preset-* blocks...');
for (const [presetName, presetKeys] of Object.entries(presetBlocks)) {
  const missingReading = [...readingContentContract].filter(k => !presetKeys.has(k));
  if (missingReading.length > 0) {
    console.log(`  MISSING in #content.reading-preset-${presetName}: ${missingReading.join(', ')}`);
    hasErrors = true;
  }
}

if (hasErrors) {
  console.log('\nContract completeness check FAILED.');
  process.exit(1);
} else {
  console.log('Contract completeness check PASSED.');
  process.exit(0);
}
