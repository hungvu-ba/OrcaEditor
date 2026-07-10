// Build script: bundle extension (Node) + webview (browser) + copy static assets.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');
const buildTest = process.argv.includes('--test');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ['media/webview/main.ts'],
  bundle: true,
  outfile: 'dist/webview/main.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: !production,
  minify: production,
};

/** @type {import('esbuild').BuildOptions} */
const testConfig = {
  entryPoints: ['test/roundtrip.ts'],
  bundle: true,
  outfile: 'dist/test/roundtrip.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  // turndown dùng domino trên Node — bundle được, không cần external.
};

function copyAssets() {
  fs.mkdirSync('dist/webview', { recursive: true });
  for (const f of ['markdown.css', 'editor.css']) {
    fs.copyFileSync(path.join('media', f), path.join('dist/webview', f));
  }
  // KaTeX css + fonts
  const katexDist = path.join('node_modules', 'katex', 'dist');
  if (fs.existsSync(katexDist)) {
    fs.mkdirSync('dist/webview/katex/fonts', { recursive: true });
    fs.copyFileSync(path.join(katexDist, 'katex.min.css'), 'dist/webview/katex/katex.min.css');
    // Webview chạy trên Chromium — chỉ cần .woff2 (đứng đầu @font-face src),
    // bỏ .ttf/.woff để giảm kích thước bundle. Giữ nguyên katex.min.css.
    const fontsSrc = path.join(katexDist, 'fonts');
    for (const font of fs.readdirSync(fontsSrc)) {
      if (font.endsWith('.woff2')) {
        fs.copyFileSync(path.join(fontsSrc, font), path.join('dist/webview/katex/fonts', font));
      }
    }
  }
}

async function main() {
  copyAssets();
  const configs = [extensionConfig, webviewConfig];
  if (buildTest) configs.push(testConfig);
  if (watch) {
    const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(contexts.map((c) => c.watch()));
    console.log('[esbuild] watching...');
  } else {
    await Promise.all(configs.map((c) => esbuild.build(c)));
    console.log('[esbuild] build done');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
