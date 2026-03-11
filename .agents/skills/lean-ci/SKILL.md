---
name: lean-ci
description: >
  Guide for writing and modifying GitHub Actions workflows in this repository.
  Use when creating CI/CD pipelines, adding workflow jobs, modifying build steps,
  or debugging CI failures. Enforces the project's lean CI philosophy.
---

# Lean CI

This project follows a strict "CI as thin wrapper" philosophy. GitHub Actions
workflows must never contain substantive build logic. All logic lives in
locally-runnable scripts; CI just calls them.

## Principles

1. **Every CI step must be reproducible locally.** A developer should be able to
   run the exact same command on their laptop. If a step only works inside
   GitHub Actions, it violates this rule.

2. **Workflows call npm scripts, not inline shell.** Build logic belongs in
   `package.json` scripts or `build.js`, never in YAML `run:` blocks beyond a
   single command invocation.

3. **`bootstrap.sh` is the only setup step.** It downloads Node.js (with SEA
   fuse), uv, and prek into `.build-tools/`. No `actions/setup-node`, no
   `actions/setup-python`, no other setup actions. The bootstrap auto-detects
   CI via `$GITHUB_PATH` and persists PATH entries for subsequent steps.

4. **No version pinning in YAML.** The Node.js version is in `.node-version`,
   read by `bootstrap.sh`. Tool versions are managed in one place, not
   scattered across workflow files.

## Existing scripts

| npm script | What it does | When to use in CI |
|------------|-------------|-------------------|
| `npm run lint` | Lint all workspace packages | Quality gate |
| `npm test` | Test all workspace packages | Quality gate |
| `npm run ci:build` | Full build with `--skip-proto` (SEA + VSIX + zip) | Build artifacts |
| `npm run ci:package-python` | Build Python wheel via `uvx hatch build` | Python artifact |

## Workflow structure

The CI workflow (`.github/workflows/ci.yml`) has three jobs:

- **lint-and-test**: runs on ubuntu-latest with xvfb (for VS Code extension
  tests), gates all other jobs
- **build**: matrix across linux-x64, linux-arm64, macos-arm64; produces SEA
  binaries, VSIX, and distribution zips
- **package-python**: produces the Python client wheel

## Rules for modifications

When adding or modifying CI:

- **DO** add new build logic as an npm script in root `package.json`, then call
  it from the workflow with `npm run <script>`.
- **DO** use `./bootstrap.sh` as the sole setup mechanism.
- **DO** upload build outputs with `actions/upload-artifact@v4`.
- **DO NOT** add `actions/setup-node`, `actions/setup-python`, or similar
  setup actions. The bootstrap handles all toolchain setup.
- **DO NOT** put multi-line shell scripts in `run:` blocks. If it needs more
  than one command, it belongs in a script.
- **DO NOT** hardcode versions in YAML. Use `.node-version` or `package.json`.
- **DO NOT** add secrets or publishing steps without explicit approval.

## Example: adding a new CI job

Wrong (logic in YAML):

```yaml
- name: Generate docs
  run: |
    npm install -g typedoc
    npx typedoc --out docs/api packages/daemon/src/core/index.ts
    tar czf docs-api.tar.gz docs/api
```

Right (logic in npm script):

```json
"ci:docs": "typedoc --out docs/api packages/daemon/src/core/index.ts"
```

```yaml
- name: Generate docs
  run: npm run ci:docs
```

## Release workflow

`.github/workflows/release.yml` triggers on `v*` tags. It builds all platforms,
then creates a GitHub Release with the artifacts attached. Tags containing
`alpha`, `beta`, or `rc` are automatically marked as prereleases.

To create a release:

```bash
git tag v0.0.1-alpha
git push --tags
```

## Bootstrap details

`bootstrap.sh` downloads into `.build-tools/` (gitignored):

- **Node.js** from nodejs.org (version from `.node-version`) -- official
  binaries always include the NODE_SEA_FUSE sentinel
- **uv** from astral.sh -- handles Python toolchain for wheel builds
- **prek** from github.com/j178/prek -- pre-commit hook framework (Rust binary,
  no runtime dependencies). Enforces conventional commits and linting at
  commit time via `.pre-commit-config.yaml`

It detects `$GITHUB_PATH` and appends tool paths automatically so subsequent
workflow steps inherit them without sourcing `env.sh`.

## VS Code extension tests in CI

The `lint-and-test` job installs `xvfb` and runs tests via `xvfb-run -a npm test`
to provide a virtual display for the VS Code test runner. GPU acceleration is
disabled via `~/.vscode/argv.json`. This is the one CI-only prerequisite that
cannot be reproduced identically on a local machine with a display server, but
the underlying `npm test` command is the same.
