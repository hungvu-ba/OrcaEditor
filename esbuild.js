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

/**
 * Mỗi file trong test/roundtrip/ (trừ _lib.ts, hạ tầng dùng chung — không phải
 * entry point) build thành 1 bundle riêng dist/test/roundtrip/<feature>.js, để
 * chạy lại được từng feature độc lập (npm run test:roundtrip:<feature>).
 */
const roundtripFeatureFiles = fs
  .readdirSync('test/roundtrip')
  .filter((f) => f.endsWith('.ts') && !f.startsWith('_'));

/** @type {import('esbuild').BuildOptions} */
const testConfig = {
  entryPoints: roundtripFeatureFiles.map((f) => `test/roundtrip/${f}`),
  bundle: true,
  outdir: 'dist/test/roundtrip',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  // turndown dùng domino trên Node — bundle được, không cần external.
};

/** @type {import('esbuild').BuildOptions} */
const unitTestConfig = {
  entryPoints: ['test/unit.ts'],
  bundle: true,
  outfile: 'dist/test/unit.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
};

function copyAssets() {
  fs.mkdirSync('dist/webview', { recursive: true });
  for (const f of ['markdown.css', 'editor.css']) {
    fs.copyFileSync(path.join('media', f), path.join('dist/webview', f));
  }
  // Bundled fonts (Literata cho reading preset "academic" — @font-face trong
  // markdown.css trỏ url('fonts/literata/*.woff2'). Copy .woff2 + OFL.txt: media/**
  // bị .vscodeignore loại khỏi .vsix nên license phải đi kèm trong dist để tuân
  // OFL 1.1 (license phải phân phối cùng font).
  // (font, keepName) → copy .woff2/.woff + file license đi kèm vào dist. media/**
  // bị .vscodeignore loại khỏi .vsix nên license phải nằm trong dist mới ship theo
  // font (OFL 1.1 của Literata / MIT của ET Book đều yêu cầu kèm license).
  const fontFamilies = [
    { dir: 'literata', license: 'OFL.txt' }, // Literata (reading academic — tiếng Việt)
    { dir: 'et-book', license: 'LICENSE' }, // ET Book (reading academic — tiếng Anh, look ai-2027)
  ];
  for (const { dir, license } of fontFamilies) {
    const src = path.join('media', 'fonts', dir);
    if (!fs.existsSync(src)) continue;
    const dest = path.join('dist/webview/fonts', dir);
    fs.mkdirSync(dest, { recursive: true });
    for (const file of fs.readdirSync(src)) {
      if (file.endsWith('.woff2') || file.endsWith('.woff') || file === license) {
        fs.copyFileSync(path.join(src, file), path.join(dest, file));
      }
    }
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
  if (buildTest) configs.push(testConfig, unitTestConfig);
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
