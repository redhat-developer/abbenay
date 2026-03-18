#!/usr/bin/env node
/**
 * Unified Abbenay monorepo build script.
 *
 * One command builds everything:
 *   node build.js                # Full build (proto + SEA + VSIX + zip)
 *   node build.js --proto-only   # Just regenerate gRPC clients
 *   node build.js --skip-sea     # (REMOVED — SEA is always required)
 *   node build.js --skip-proto   # Skip proto generation (use existing generated code)
 *   node build.js --skip-zip     # Skip zip creation
 *   node build.js --code-install # Install VSIX into VS Code after building
 *
 * Prerequisites: Node.js >= 20, python3, protoc
 * For SEA: official Node.js binary with SEA fuse (set NODE_SEA_BASE env var)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Paths ──────────────────────────────────────────────────────────────
const ROOT = __dirname;
const PROTO_DIR = path.join(ROOT, 'proto');
const PROTO_FILE = path.join(PROTO_DIR, 'abbenay', 'v1', 'service.proto');
const DAEMON_ROOT = path.join(ROOT, 'packages', 'daemon');
const VSCODE_ROOT = path.join(ROOT, 'packages', 'vscode');
const PYTHON_ROOT = path.join(ROOT, 'packages', 'python');
const PROTO_TS_ROOT = path.join(ROOT, 'packages', 'proto-ts');

const IS_WIN = process.platform === 'win32';
const PLATFORM = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
const ARCH = process.arch; // x64, arm64
const DIST_DIR = path.join(ROOT, 'dist');
const PLATFORM_DIR = path.join(DIST_DIR, `${PLATFORM}-${ARCH}`);

// ── CLI flags ──────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));
const PROTO_ONLY = args.has('--proto-only');
const SKIP_SEA = args.has('--skip-sea');
const SKIP_PROTO = args.has('--skip-proto');
const SKIP_ZIP = args.has('--skip-zip');
const CODE_INSTALL = args.has('--code-install');

// ── Helpers ────────────────────────────────────────────────────────────
function run(cmd, opts = {}) {
    console.log(`  $ ${cmd}`);
    execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function copyDirRecursive(src, dest) {
    ensureDir(dest);
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(s, d);
        } else {
            fs.copyFileSync(s, d);
        }
    }
}

function banner(msg) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ${msg}`);
    console.log(`${'='.repeat(60)}\n`);
}

// ═══════════════════════════════════════════════════════════════════════
// Stage 1: Generate Python gRPC client
// ═══════════════════════════════════════════════════════════════════════
function generatePython() {
    banner('Stage 1: Generate Python gRPC client');

    // Check prerequisites
    try { execSync('python3 --version', { stdio: 'pipe' }); }
    catch { console.warn('  SKIP: python3 not found'); return; }

    const venvDir = path.join(ROOT, '.build-venv');
    const venvPython = IS_WIN
        ? path.join(venvDir, 'Scripts', 'python.exe')
        : path.join(venvDir, 'bin', 'python3');

    // Create or reuse temp venv
    if (!fs.existsSync(venvPython)) {
        console.log('  Creating temporary build venv...');
        run(`python3 -m venv "${venvDir}"`);
        run(`"${venvPython}" -m pip install --quiet grpcio-tools`);
    } else {
        console.log('  Reusing cached build venv');
    }

    // Generate
    const pyOut = path.join(PYTHON_ROOT, 'src', 'abbenay_grpc');
    ensureDir(path.join(pyOut, 'abbenay', 'v1'));

    run(
        `"${venvPython}" -m grpc_tools.protoc ` +
        `-I "${PROTO_DIR}" ` +
        `--python_out="${pyOut}" ` +
        `--pyi_out="${pyOut}" ` +
        `--grpc_python_out="${pyOut}" ` +
        `"${PROTO_FILE}"`
    );

    // Create __init__.py files
    fs.writeFileSync(path.join(pyOut, 'abbenay', '__init__.py'), '');
    fs.writeFileSync(path.join(pyOut, 'abbenay', 'v1', '__init__.py'), '');

    // Fix imports: protoc generates "from abbenay.v1 import ..." which only
    // resolves if abbenay_grpc/ is on sys.path. Rewrite to package-relative
    // "from abbenay_grpc.abbenay.v1 import ..." so it works when pip-installed.
    const grpcStub = path.join(pyOut, 'abbenay', 'v1', 'service_pb2_grpc.py');
    if (fs.existsSync(grpcStub)) {
        let content = fs.readFileSync(grpcStub, 'utf8');
        content = content.replace(
            /from abbenay\./g,
            'from abbenay_grpc.abbenay.',
        );
        fs.writeFileSync(grpcStub, content);
        console.log('  Fixed proto imports in service_pb2_grpc.py');
    }

    console.log(`  Python client generated at ${pyOut}`);
}

// ═══════════════════════════════════════════════════════════════════════
// Stage 2: Generate TypeScript gRPC client
// ═══════════════════════════════════════════════════════════════════════
function generateTypeScript() {
    banner('Stage 2: Generate TypeScript gRPC client');

    // Check prerequisites
    try { execSync('protoc --version', { stdio: 'pipe' }); }
    catch { console.warn('  SKIP: protoc not found'); return; }

    const tsProtoPlugin = path.join(ROOT, 'node_modules', '.bin', 'protoc-gen-ts_proto');
    if (!fs.existsSync(tsProtoPlugin)) {
        console.error('  ERROR: ts-proto not found. Run: npm install');
        process.exit(1);
    }

    // Generate to packages/proto-ts/src/
    const tsOut = path.join(PROTO_TS_ROOT, 'src');
    ensureDir(tsOut);

    run(
        `protoc ` +
        `--plugin="protoc-gen-ts_proto=${tsProtoPlugin}" ` +
        `--ts_proto_out="${tsOut}" ` +
        `--ts_proto_opt=outputServices=nice-grpc ` +
        `--ts_proto_opt=outputServices=generic-definitions ` +
        `--ts_proto_opt=useExactTypes=false ` +
        `--ts_proto_opt=esModuleInterop=true ` +
        `--ts_proto_opt=env=node ` +
        `--ts_proto_opt=forceLong=long ` +
        `--ts_proto_opt=oneof=unions ` +
        `-I "${PROTO_DIR}" ` +
        `"${PROTO_FILE}"`
    );

    console.log(`  TypeScript client generated at ${tsOut}`);

    // Copy to VS Code extension
    const vscodeProto = path.join(VSCODE_ROOT, 'src', 'proto');
    ensureDir(vscodeProto);
    copyDirRecursive(tsOut, vscodeProto);
    console.log(`  Copied to VS Code extension at ${vscodeProto}`);
}

// ═══════════════════════════════════════════════════════════════════════
// Stage 3: Build daemon (SEA binary)
// ═══════════════════════════════════════════════════════════════════════
function buildDaemon() {
    banner('Stage 3: Build daemon (SEA)');

    const binDir = path.join(VSCODE_ROOT, 'bin');
    ensureDir(binDir);

    // Type-check
    run('npm run build', { cwd: DAEMON_ROOT });

    if (SKIP_SEA) {
        console.error('  ERROR: --skip-sea is not supported. The daemon requires a SEA binary.');
        console.error('  Set NODE_SEA_BASE=/path/to/official/node if your system node lacks the SEA fuse.');
        process.exit(1);
    }

    // Build SEA via daemon's own build script
    run('node build.js --skip-zip', {
        cwd: DAEMON_ROOT,
        env: { ...process.env, NODE_SEA_BASE: process.env.NODE_SEA_BASE || '' },
    });

    // Copy SEA output to extension bin/
    const seaDir = path.join(DAEMON_ROOT, 'dist', 'sea');
    if (fs.existsSync(seaDir)) {
        for (const entry of fs.readdirSync(seaDir, { withFileTypes: true })) {
            const src = path.join(seaDir, entry.name);
            const dest = path.join(binDir, entry.name);
            if (entry.isFile()) {
                fs.copyFileSync(src, dest);
                if (entry.name.startsWith('abbenay-daemon-') || entry.name.endsWith('.node')) {
                    fs.chmodSync(dest, 0o755);
                }
            } else if (entry.isDirectory()) {
                copyDirRecursive(src, dest);
            }
        }
        console.log('  SEA + sidecars copied to extension bin/');
    }
}

// Stage 3b removed: vendor list is now static in package.json (single "abbenay" vendor).
// No build-time generation needed.

// ═══════════════════════════════════════════════════════════════════════
// Stage 4: Package VS Code extension
// ═══════════════════════════════════════════════════════════════════════
function packageExtension() {
    banner('Stage 4: Package VS Code extension');

    // Bundle the extension code with esbuild
    run('node esbuild.js --production', { cwd: VSCODE_ROOT });

    // Map our platform-arch to VS Code marketplace target identifiers
    const vsceTarget = `${PLATFORM}-${ARCH}`;
    run(`npx vsce package --no-dependencies --target ${vsceTarget}`, { cwd: VSCODE_ROOT });

    const vsixFiles = fs.readdirSync(VSCODE_ROOT).filter(f => f.endsWith('.vsix'));
    if (vsixFiles.length > 0) {
        console.log(`  VSIX: ${path.join(VSCODE_ROOT, vsixFiles[0])}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Stage 5: Create distribution zip
// ═══════════════════════════════════════════════════════════════════════
function createDistribution() {
    banner('Stage 5: Create distribution');

    ensureDir(PLATFORM_DIR);

    // Copy SEA binary
    const seaDir = path.join(DAEMON_ROOT, 'dist', 'sea');
    const seaBinaryName = `abbenay-daemon-${PLATFORM}-${ARCH}`;
    const seaBinary = path.join(seaDir, seaBinaryName);
    if (fs.existsSync(seaBinary)) {
        fs.copyFileSync(seaBinary, path.join(PLATFORM_DIR, seaBinaryName));
        fs.chmodSync(path.join(PLATFORM_DIR, seaBinaryName), 0o755);
    }

    // Copy keytar.node sidecar
    const keytarNode = path.join(seaDir, 'keytar.node');
    if (fs.existsSync(keytarNode)) {
        fs.copyFileSync(keytarNode, path.join(PLATFORM_DIR, 'keytar.node'));
    }

    // Copy proto + static
    const protoDest = path.join(PLATFORM_DIR, 'proto');
    if (!fs.existsSync(protoDest)) {
        copyDirRecursive(PROTO_DIR, protoDest);
    }
    const staticSrc = path.join(DAEMON_ROOT, 'static');
    const staticDest = path.join(PLATFORM_DIR, 'static');
    if (fs.existsSync(staticSrc) && !fs.existsSync(staticDest)) {
        ensureDir(staticDest);
        for (const f of fs.readdirSync(staticSrc)) {
            fs.copyFileSync(path.join(staticSrc, f), path.join(staticDest, f));
        }
    }

    // Copy VSIX
    const vsixFiles = fs.readdirSync(VSCODE_ROOT).filter(f => f.endsWith('.vsix'));
    for (const vsix of vsixFiles) {
        fs.copyFileSync(path.join(VSCODE_ROOT, vsix), path.join(DIST_DIR, vsix));
    }

    // Archive
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const version = pkg.version || '0.0.0-dev';
    const ext = IS_WIN ? '.zip' : '.tar.gz';
    const archiveName = `abbenay-${version}-${PLATFORM}-${ARCH}${ext}`;
    const archivePath = path.join(DIST_DIR, archiveName);
    console.log(`  Creating ${archiveName}...`);
    if (IS_WIN) {
        run(`powershell Compress-Archive -Path "${PLATFORM_DIR}/*" -DestinationPath "${archivePath}" -Force`);
    } else {
        run(`tar czf "${archivePath}" -C "${PLATFORM_DIR}" .`);
    }

    console.log(`  Distribution: ${archivePath}`);
    if (vsixFiles.length > 0) {
        console.log(`  Extension:    ${path.join(DIST_DIR, vsixFiles[0])}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Stage 6: Install VSIX into VS Code
// ═══════════════════════════════════════════════════════════════════════
function installExtension() {
    banner('Stage 6: Install extension into VS Code');

    const vsixFiles = fs.readdirSync(VSCODE_ROOT).filter(f => f.endsWith('.vsix'));
    if (vsixFiles.length === 0) {
        console.error('  ERROR: No .vsix file found — cannot install');
        return;
    }

    const vsixPath = path.join(VSCODE_ROOT, vsixFiles[0]);
    console.log(`  Installing ${vsixFiles[0]}...`);

    // Uninstall first to force a clean install (--force alone doesn't always replace files)
    try {
        run('code --uninstall-extension abbenay.abbenay-provider 2>/dev/null || true');
    } catch { /* ignore if not installed */ }

    // Remove stale extension directories
    const extDir = path.join(process.env.HOME || '~', '.vscode', 'extensions');
    if (fs.existsSync(extDir)) {
        for (const entry of fs.readdirSync(extDir)) {
            if (entry.startsWith('abbenay.abbenay-provider-')) {
                const fullPath = path.join(extDir, entry);
                console.log(`  Removing stale: ${entry}`);
                fs.rmSync(fullPath, { recursive: true, force: true });
            }
        }
    }

    run(`code --install-extension "${vsixPath}" --force`);
    console.log('  Extension installed. Reload VS Code to activate.');
}

// ═══════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════
async function main() {
    const startTime = Date.now();
    console.log(`Abbenay build for ${PLATFORM}-${ARCH}`);

    // Stage 1 & 2: Proto generation
    if (!SKIP_PROTO) {
        generatePython();
        generateTypeScript();
    } else {
        console.log('\nSkipping proto generation (--skip-proto)\n');
    }

    if (PROTO_ONLY) {
        console.log('\nDone (--proto-only)');
        return;
    }

    // Stage 3: Build daemon (SEA)
    buildDaemon();

    // Stage 3b removed: vendor list is static (single "abbenay" vendor)

    // Stage 4: Package extension
    packageExtension();

    // Stage 5: Distribution zip
    if (!SKIP_ZIP) {
        createDistribution();
    }

    // Stage 6: Install into VS Code
    if (CODE_INSTALL) {
        installExtension();
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    banner(`Build complete in ${elapsed}s`);
}

main().catch(e => {
    console.error('Build failed:', e.message);
    process.exit(1);
});
