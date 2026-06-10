const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd(result => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(`    ${location.file}:${location.line}:${location.column}:`);
      });
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  // Extension host bundle (Node.js, CJS)
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'out/extension.js',
    external: ['vscode'],
    logLevel: 'info',
    plugins: [
      ...(watch ? [esbuildProblemMatcherPlugin] : []),
    ],
  });

  // Webview UI bundles (browser context, IIFE to avoid exports issue)
  const webviewCtx = await esbuild.context({
    entryPoints: [
      'src/webview-ui/provider/main.ts',
      'src/webview-ui/chat/main.ts',
    ],
    bundle: true,
    format: 'iife',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'browser',
    outdir: 'out/webview-ui',
    logLevel: 'info',
    plugins: [
      ...(watch ? [esbuildProblemMatcherPlugin] : []),
    ],
  });

  if (watch) {
    await Promise.all([ctx.watch(), webviewCtx.watch()]);
  } else {
    await Promise.all([ctx.rebuild(), webviewCtx.rebuild()]);
    await Promise.all([ctx.dispose(), webviewCtx.dispose()]);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
