#!/usr/bin/env node
/**
 * Bundle the Abbenay daemon for the VS Code extension.
 *
 * Delegates to packages/daemon/build.js which handles the entire pipeline:
 * esbuild bundle -> SEA injection -> sidecar copy.
 *
 * Then copies the output into the extension's bin/ directory.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const EXTENSION_ROOT = path.resolve(__dirname, '..');
const DAEMON_ROOT = path.resolve(EXTENSION_ROOT, '..', 'daemon');
const BIN_DIR = path.join(EXTENSION_ROOT, 'bin');
const SEA_OUTPUT = path.join(DAEMON_ROOT, 'dist', 'sea');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function copyDirRecursive(src, dest) {
    ensureDir(dest);
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

function bundleDaemon() {
    console.log('Building Abbenay daemon for VS Code extension...');
    ensureDir(BIN_DIR);

    // Run the unified build script (--skip-zip since we embed in the VSIX)
    try {
        execSync('node build.js --skip-zip', {
            cwd: DAEMON_ROOT,
            stdio: 'inherit',
            env: {
                ...process.env,
                // Pass through NODE_SEA_BASE if set
                NODE_SEA_BASE: process.env.NODE_SEA_BASE || '',
            },
        });
    } catch (e) {
        console.error('SEA build failed:', e.message);
        process.exit(1);
    }

    // Copy build output to extension bin/
    if (fs.existsSync(SEA_OUTPUT)) {
        const entries = fs.readdirSync(SEA_OUTPUT, { withFileTypes: true });
        for (const entry of entries) {
            const src = path.join(SEA_OUTPUT, entry.name);
            const dest = path.join(BIN_DIR, entry.name);
            if (entry.isDirectory()) {
                copyDirRecursive(src, dest);
            } else {
                fs.copyFileSync(src, dest);
                // Preserve executable permission on binaries
                if (entry.name.startsWith('abbenay-daemon-') || entry.name.endsWith('.node')) {
                    fs.chmodSync(dest, 0o755);
                }
            }
        }
        console.log('Copied daemon build output to extension bin/');
    }

    console.log('Done!');
}

bundleDaemon();
