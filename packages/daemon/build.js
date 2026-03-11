#!/usr/bin/env node
/**
 * Abbenay Daemon — Unified Build Script
 *
 * Handles the entire pipeline: esbuild bundle -> SEA blob -> inject -> sidecar copy -> zip.
 * A developer just needs Node.js and npm to build the whole project.
 *
 * Usage:
 *   node build.js              # Build SEA for current platform
 *   node build.js --skip-zip   # Build SEA but skip creating the zip
 *
 * Environment:
 *   NODE_SEA_BASE=/path/to/node   # Override the node binary used as the SEA base
 *                                  # (must contain the NODE_SEA_FUSE sentinel)
 */

import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IS_WIN = process.platform === 'win32';
const APP_NAME = 'abbenay-daemon';
const PLATFORM = process.platform === 'win32' ? 'win32'
  : process.platform === 'darwin' ? 'darwin' : 'linux';
const ARCH = process.arch;
const EXE_NAME = IS_WIN ? `${APP_NAME}-${PLATFORM}-${ARCH}.exe` : `${APP_NAME}-${PLATFORM}-${ARCH}`;
const PLATFORM_DIR = path.join(__dirname, 'dist', 'sea');
const REPO_ROOT = path.resolve(__dirname, '../..');

const SKIP_ZIP = process.argv.includes('--skip-zip');

async function build() {
  console.log(`Building Abbenay daemon for ${PLATFORM}-${ARCH}...`);

  // ── 0. Preflight: verify SEA prerequisites before doing any work ──────
  console.log('[preflight] Checking SEA prerequisites...');
  const nodeBase = findNodeBase();
  const postjectBin = findPostject();
  console.log('[preflight] OK — node base and postject ready\n');

  // ── 1. Clean & Setup ──────────────────────────────────────────────────
  if (fs.existsSync(PLATFORM_DIR)) {
    fs.rmSync(PLATFORM_DIR, { recursive: true });
  }
  fs.mkdirSync(PLATFORM_DIR, { recursive: true });

  // ── 2. esbuild: ESM source -> CJS bundle ─────────────────────────────
  // SEA requires CJS. We shim import.meta.url so that fileURLToPath() and
  // path resolution still work correctly inside the binary.
  // In a SEA, __filename resolves to the executable path on disk.
  console.log('[1/5] Bundling with esbuild (CJS for SEA)...');

  const bundlePath = path.join(PLATFORM_DIR, 'bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'src', 'daemon', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: bundlePath,
    external: ['keytar'],
    define: { 'import.meta.url': 'import_meta_url' },
    banner: {
      js: 'const import_meta_url = require("url").pathToFileURL(__filename).href;',
    },
  });
  console.log(`  Bundle: ${bundlePath} (${formatSize(fs.statSync(bundlePath).size)})`);

  // ── 1b. Build @abbenay/core package ──────────────────────────────────
  console.log('[1b/5] Building @abbenay/core package...');

  const coreOutDir = path.join(__dirname, 'dist', 'core');
  // Don't clean dist/core/ — tsc may have already written .d.ts files there.
  // esbuild will overwrite index.js; .d.ts files are preserved.
  fs.mkdirSync(coreOutDir, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(__dirname, 'src', 'core', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: path.join(coreOutDir, 'index.js'),
    external: [
      'ai', '@ai-sdk/*', 'zod', 'js-yaml',
    ],
  });

  // Ensure type declarations exist (tsc --emitDeclarationOnly if missing)
  if (!fs.existsSync(path.join(coreOutDir, 'index.d.ts'))) {
    console.log('  Generating type declarations...');
    execSync('npx tsc --project tsconfig.json --emitDeclarationOnly --outDir dist', {
      cwd: __dirname,
      stdio: 'inherit',
    });
  }

  // Generate package.json for core
  const rootPkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
  const corePkg = {
    name: '@abbenay/core',
    version: rootPkg.version || '0.1.0',
    type: 'module',
    main: 'index.js',
    types: 'index.d.ts',
    dependencies: {
      ai: '^5',
      'js-yaml': '^4',
      zod: '^3',
    },
    peerDependencies: {
      '@ai-sdk/openai': '^2',
      '@ai-sdk/anthropic': '^2',
      '@ai-sdk/google': '^2',
      '@ai-sdk/mistral': '^2',
      '@ai-sdk/xai': '^1',
      '@ai-sdk/deepseek': '^1',
      '@ai-sdk/groq': '^1',
      '@ai-sdk/cohere': '^2',
      '@ai-sdk/amazon-bedrock': '^2',
      '@ai-sdk/fireworks': '^1',
      '@ai-sdk/togetherai': '^1',
      '@ai-sdk/perplexity': '^1',
      '@ai-sdk/openai-compatible': '^0',
    },
    peerDependenciesMeta: {
      '@ai-sdk/openai': { optional: true },
      '@ai-sdk/anthropic': { optional: true },
      '@ai-sdk/google': { optional: true },
      '@ai-sdk/mistral': { optional: true },
      '@ai-sdk/xai': { optional: true },
      '@ai-sdk/deepseek': { optional: true },
      '@ai-sdk/groq': { optional: true },
      '@ai-sdk/cohere': { optional: true },
      '@ai-sdk/amazon-bedrock': { optional: true },
      '@ai-sdk/fireworks': { optional: true },
      '@ai-sdk/togetherai': { optional: true },
      '@ai-sdk/perplexity': { optional: true },
      '@ai-sdk/openai-compatible': { optional: true },
    },
  };
  fs.writeFileSync(path.join(coreOutDir, 'package.json'), JSON.stringify(corePkg, null, 2));
  console.log(`  Core package: ${coreOutDir} (${formatSize(fs.statSync(path.join(coreOutDir, 'index.js')).size)})`);

  // ── 3. Copy sidecar files ─────────────────────────────────────────────
  // Proto files (grpc proto-loader reads from disk at runtime)
  // Static files (express.static serves from disk)
  console.log('[2/5] Copying sidecar files...');

  const protoSrc = path.join(REPO_ROOT, 'proto');
  const protoDest = path.join(PLATFORM_DIR, 'proto');
  if (fs.existsSync(protoSrc)) {
    copyDirRecursive(protoSrc, protoDest);
    console.log('  Copied proto/');
  } else {
    console.error(`  ERROR: Proto directory not found: ${protoSrc}`);
    process.exit(1);
  }

  const staticSrc = path.join(__dirname, 'static');
  const staticDest = path.join(PLATFORM_DIR, 'static');
  if (fs.existsSync(staticSrc)) {
    copyDirRecursive(staticSrc, staticDest);
    console.log('  Copied static/');
  }

  // keytar.node native addon
  const keytarNode = findKeytarNode();
  if (keytarNode) {
    fs.copyFileSync(keytarNode, path.join(PLATFORM_DIR, 'keytar.node'));
    console.log('  Copied keytar.node');
  } else {
    console.warn('  WARNING: keytar.node not found — keychain storage will be unavailable');
  }

  // ── 4. Generate SEA blob & inject ─────────────────────────────────────
  console.log('[3/5] Generating SEA preparation blob...');

  const seaConfig = path.join(PLATFORM_DIR, 'sea-config.json');
  const seaBlob = path.join(PLATFORM_DIR, 'sea-prep.blob');
  fs.writeFileSync(seaConfig, JSON.stringify({
    main: bundlePath,
    output: seaBlob,
    disableExperimentalSEAWarning: true,
  }));

  execSync(`node --experimental-sea-config "${seaConfig}"`, { stdio: 'inherit' });
  console.log(`  Blob: ${seaBlob} (${formatSize(fs.statSync(seaBlob).size)})`);

  console.log('[4/5] Injecting blob into node binary...');

  const seaBinary = path.join(PLATFORM_DIR, EXE_NAME);

  fs.copyFileSync(nodeBase, seaBinary);
  fs.chmodSync(seaBinary, 0o755);
  const sentinel = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
  const machoFlag = PLATFORM === 'darwin' ? ' --macho-segment-name NODE_SEA' : '';
  execSync(
    `"${postjectBin}" "${seaBinary}" NODE_SEA_BLOB "${seaBlob}" --sentinel-fuse ${sentinel}${machoFlag} --overwrite`,
    { stdio: 'inherit' }
  );

  if (PLATFORM === 'darwin') {
    execSync(`codesign --sign - "${seaBinary}"`, { stdio: 'inherit' });
    console.log('  Re-signed binary (ad-hoc) for macOS');
  }
  console.log(`  Binary: ${seaBinary} (${formatSize(fs.statSync(seaBinary).size)})`);

  // Clean up intermediate files
  fs.unlinkSync(bundlePath);
  fs.unlinkSync(seaBlob);
  fs.unlinkSync(seaConfig);

  // ── 5. Create distribution zip ────────────────────────────────────────
  if (!SKIP_ZIP) {
    console.log('[5/5] Creating distribution zip...');
    const zipName = `${APP_NAME}-${PLATFORM}-${ARCH}.zip`;
    const zipPath = path.join(__dirname, 'dist', zipName);

    if (IS_WIN) {
      execSync(`powershell Compress-Archive -Path "${PLATFORM_DIR}/*" -DestinationPath "${zipPath}" -Force`);
    } else {
      execSync(`cd "${PLATFORM_DIR}" && zip -r "${zipPath}" .`);
    }
    console.log(`  Zip: ${zipPath} (${formatSize(fs.statSync(zipPath).size)})`);
  } else {
    console.log('[5/5] Skipping zip (--skip-zip)');
  }

  console.log('\nBuild complete!');
  console.log(`  SEA binary: ${seaBinary}`);
  console.log(`\nTest with:`);
  console.log(`  ${seaBinary} daemon`);
  console.log(`  ${seaBinary} web`);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function findKeytarNode() {
  const candidates = [
    path.join(__dirname, 'node_modules', 'keytar', 'build', 'Release', 'keytar.node'),
    path.join(REPO_ROOT, 'node_modules', 'keytar', 'build', 'Release', 'keytar.node'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function findNodeBase() {
  // 1) NODE_SEA_BASE env var (explicit override, CI friendly)
  if (process.env.NODE_SEA_BASE && fs.existsSync(process.env.NODE_SEA_BASE)) {
    console.log(`  Base node (NODE_SEA_BASE): ${process.env.NODE_SEA_BASE}`);
    return process.env.NODE_SEA_BASE;
  }
  // 2) System node (must contain the SEA fuse)
  const systemNode = process.execPath;
  try {
    const buf = fs.readFileSync(systemNode);
    if (buf.indexOf('NODE_SEA_FUSE') >= 0) {
      console.log(`  Base node (system): ${systemNode}`);
      return systemNode;
    }
  } catch { /* ignore */ }

  console.error('ERROR: No suitable node binary found for SEA injection.');
  console.error('The node binary must contain the NODE_SEA_FUSE sentinel.');
  console.error('Set NODE_SEA_BASE=/path/to/official/node (download from nodejs.org)');
  process.exit(1);
}

function findPostject() {
  const candidates = [
    path.join(__dirname, 'node_modules', '.bin', 'postject'),
    path.join(REPO_ROOT, 'node_modules', '.bin', 'postject'),
  ];
  if (IS_WIN) {
    candidates.unshift(
      path.join(__dirname, 'node_modules', '.bin', 'postject.cmd'),
      path.join(REPO_ROOT, 'node_modules', '.bin', 'postject.cmd'),
    );
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  console.error('ERROR: postject not found. Run: npm install');
  process.exit(1);
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
