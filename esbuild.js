const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Reports build failures with file/line info instead of esbuild's default dump. */
const problemMatcherPlugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onStart(() => console.log('[build] started'));
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}`);
        }
      }
      console.log(`[build] finished with ${result.errors.length} error(s)`);
    });
  },
};

/**
 * Vendors KaTeX into `media/katex/`. The webview runs under a strict CSP with no
 * network access, so math must be rendered from local assets. Only `.woff2` is
 * shipped — every VS Code-supported Electron build reads it — and the other
 * font formats are stripped from the stylesheet so they never 404.
 */
function copyKatexAssets() {
  const source = path.join(__dirname, 'node_modules', 'katex', 'dist');
  const target = path.join(__dirname, 'media', 'katex');
  if (!fs.existsSync(source)) {
    console.warn('[build] katex not installed; math rendering will be unavailable');
    return;
  }

  fs.mkdirSync(path.join(target, 'fonts'), { recursive: true });
  fs.copyFileSync(path.join(source, 'katex.min.js'), path.join(target, 'katex.min.js'));

  const css = fs
    .readFileSync(path.join(source, 'katex.min.css'), 'utf8')
    // Drop the `url(fonts/X.woff)` / `.ttf` alternatives from each src list.
    .replace(/,url\([^)]*\.(woff|ttf)\)\s*format\("(woff|truetype)"\)/g, '');
  fs.writeFileSync(path.join(target, 'katex.min.css'), css);

  let fonts = 0;
  for (const file of fs.readdirSync(path.join(source, 'fonts'))) {
    if (file.endsWith('.woff2')) {
      fs.copyFileSync(
        path.join(source, 'fonts', file),
        path.join(target, 'fonts', file),
      );
      fonts += 1;
    }
  }
  console.log(`[build] vendored katex (${fonts} fonts)`);
}

async function main() {
  copyKatexAssets();

  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'silent',
    plugins: [problemMatcherPlugin],
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
