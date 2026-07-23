#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS_DIR="${SCRIPT_DIR}/.build-tools"
NODE_VERSION_FILE="${SCRIPT_DIR}/.node-version"

if [ ! -f "$NODE_VERSION_FILE" ]; then
  echo "ERROR: .node-version file not found" >&2
  exit 1
fi
NODE_VERSION="$(tr -d '[:space:]' < "$NODE_VERSION_FILE")"

# ── Platform detection ────────────────────────────────────────────────────

detect_platform() {
  local uname_s uname_m
  uname_s="$(uname -s 2>/dev/null || echo unknown)"
  uname_m="$(uname -m 2>/dev/null || echo unknown)"

  # Use HOST_OS (not OS) — Windows sets OS=Windows_NT in the environment.
  case "$uname_s" in
    Linux)  HOST_OS="linux" ;;
    Darwin) HOST_OS="darwin" ;;
    MINGW*|MSYS*|CYGWIN*)
      HOST_OS="win"
      ;;
    *)
      if [ "${OS:-}" = "Windows_NT" ] || [ -n "${WINDIR:-}" ]; then
        HOST_OS="win"
      else
        echo "ERROR: Unsupported OS: $uname_s" >&2
        exit 1
      fi
      ;;
  esac

  case "$uname_m" in
    x86_64|x64|amd64) ARCH="x64" ;;
    aarch64|arm64)    ARCH="arm64" ;;
    *)
      echo "ERROR: Unsupported architecture: $uname_m" >&2
      exit 1
      ;;
  esac

  # Official Node.js Windows archives use "win", not "win32"
  if [ "$HOST_OS" = "win" ] && [ "$ARCH" != "x64" ]; then
    echo "ERROR: Windows bootstrap currently supports x64 only (got ${ARCH})" >&2
    exit 1
  fi
}

detect_platform

# ── Node.js ───────────────────────────────────────────────────────────────

if [ "$HOST_OS" = "win" ]; then
  NODE_DIR="node-v${NODE_VERSION}-win-${ARCH}"
  NODE_BIN_DIR="${TOOLS_DIR}/${NODE_DIR}"
  NODE_ARCHIVE="${NODE_DIR}.zip"
  NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"
  NODE_BIN="${NODE_BIN_DIR}/node.exe"
else
  NODE_DIR="node-v${NODE_VERSION}-${HOST_OS}-${ARCH}"
  NODE_BIN_DIR="${TOOLS_DIR}/${NODE_DIR}/bin"
  NODE_ARCHIVE="${NODE_DIR}.tar.xz"
  NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"
  NODE_BIN="${NODE_BIN_DIR}/node"
fi

install_node() {
  if [ -x "$NODE_BIN" ] || [ -f "$NODE_BIN" ]; then
    echo "Node.js ${NODE_VERSION} already installed"
    return
  fi

  echo "Downloading Node.js ${NODE_VERSION} (${HOST_OS}-${ARCH})..."
  mkdir -p "$TOOLS_DIR"

  if [ "$HOST_OS" = "win" ]; then
    local archive_path="${TOOLS_DIR}/${NODE_ARCHIVE}"
    curl -fsSL "$NODE_URL" -o "$archive_path"
    # Prefer unzip (Git Bash); fall back to PowerShell Expand-Archive
    if command -v unzip >/dev/null 2>&1; then
      unzip -q -o "$archive_path" -d "$TOOLS_DIR"
    else
      powershell.exe -NoProfile -Command \
        "Expand-Archive -Path '$archive_path' -DestinationPath '$TOOLS_DIR' -Force"
    fi
    rm -f "$archive_path"
  else
    curl -fsSL "$NODE_URL" | tar xJ -C "$TOOLS_DIR"
  fi

  if [ ! -x "$NODE_BIN" ] && [ ! -f "$NODE_BIN" ]; then
    echo "ERROR: Node.js download failed — ${NODE_BIN} not found" >&2
    exit 1
  fi

  echo "  Installed: ${NODE_BIN}"
}

validate_sea_fuse() {
  local node_bin="$NODE_BIN"
  if grep -q 'NODE_SEA_FUSE' "$node_bin" 2>/dev/null; then
    echo "  NODE_SEA_FUSE sentinel: OK"
  else
    echo "ERROR: Downloaded Node.js binary is missing NODE_SEA_FUSE sentinel." >&2
    echo "       SEA builds will fail. This should not happen with official nodejs.org binaries." >&2
    exit 1
  fi
}

# ── uv (Python toolchain) ────────────────────────────────────────────────

UV_BIN_DIR="${TOOLS_DIR}/bin"

install_uv() {
  if [ "$HOST_OS" = "win" ]; then
    local uv_exe="${UV_BIN_DIR}/uv.exe"
    if [ -f "$uv_exe" ]; then
      echo "uv already installed"
      return
    fi
    echo "Downloading uv (Windows)..."
    mkdir -p "$UV_BIN_DIR"
    # Install into our tools dir (no PATH mutation)
    UV_INSTALL_DIR="$(cygpath -w "$UV_BIN_DIR" 2>/dev/null || echo "$UV_BIN_DIR")" \
      powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \
      "irm https://astral.sh/uv/install.ps1 | iex"
    if [ ! -f "$uv_exe" ]; then
      echo "ERROR: uv install failed — ${uv_exe} not found" >&2
      exit 1
    fi
    echo "  Installed: ${uv_exe}"
    return
  fi

  if [ -x "${UV_BIN_DIR}/uv" ]; then
    echo "uv already installed"
    return
  fi

  echo "Downloading uv..."
  mkdir -p "$UV_BIN_DIR"
  curl -LsSf https://astral.sh/uv/install.sh | \
    INSTALLER_NO_MODIFY_PATH=1 UV_INSTALL_DIR="$UV_BIN_DIR" sh 2>&1 | \
    grep -v "^$" | grep -v "^To add" | grep -v "^    source" | grep -v "^WARN:"
  echo "  Installed: ${UV_BIN_DIR}/uv"
}

# ── prek (pre-commit hooks) ────────────────────────────────────────────────

PREK_BIN_DIR="${TOOLS_DIR}/prek/bin"
PREK_VERSION="0.3.5"

install_prek() {
  if [ "$HOST_OS" = "win" ]; then
    local prek_exe="${PREK_BIN_DIR}/prek.exe"
    if [ -f "$prek_exe" ]; then
      echo "prek already installed"
      return
    fi
    echo "Downloading prek ${PREK_VERSION} (Windows)..."
    mkdir -p "${PREK_BIN_DIR}"
    local prek_url="https://github.com/j178/prek/releases/download/v${PREK_VERSION}/prek-x86_64-pc-windows-msvc.zip"
    local prek_zip="${TOOLS_DIR}/prek.zip"
    curl -fsSL "$prek_url" -o "$prek_zip"
    if command -v unzip >/dev/null 2>&1; then
      unzip -q -o "$prek_zip" -d "${PREK_BIN_DIR}"
    else
      powershell.exe -NoProfile -Command \
        "Expand-Archive -Path '$prek_zip' -DestinationPath '${PREK_BIN_DIR}' -Force"
    fi
    rm -f "$prek_zip"
    if [ ! -f "$prek_exe" ]; then
      # Zip may place binary at top level with different layout
      local found
      found="$(find "${PREK_BIN_DIR}" -name 'prek.exe' -type f 2>/dev/null | head -n 1 || true)"
      if [ -n "$found" ]; then
        cp "$found" "$prek_exe"
      else
        echo "ERROR: prek download failed — prek.exe not found" >&2
        exit 1
      fi
    fi
    echo "  Installed: ${prek_exe}"
    return
  fi

  if [ -x "${PREK_BIN_DIR}/prek" ]; then
    echo "prek already installed"
    return
  fi

  echo "Downloading prek ${PREK_VERSION}..."
  mkdir -p "${PREK_BIN_DIR}"
  curl --proto '=https' --tlsv1.2 -LsSf \
    "https://github.com/j178/prek/releases/download/v${PREK_VERSION}/prek-installer.sh" | \
    PREK_NO_MODIFY_PATH=1 PREK_INSTALL_DIR="${PREK_BIN_DIR}" sh 2>&1 | \
    grep -v "^$" | grep -v "^everything" | grep -v "^To add" | grep -v "^    source"
  echo "  Installed: ${PREK_BIN_DIR}/prek"
}

# ── env.sh generation ────────────────────────────────────────────────────

write_env() {
  cat > "${TOOLS_DIR}/env.sh" << ENVEOF
# Generated by bootstrap.sh — source this to put build tools on PATH
export PATH="${NODE_BIN_DIR}:${UV_BIN_DIR}:${PREK_BIN_DIR}:\$PATH"
ENVEOF

  echo ""
  echo "Build tools ready:"
  if [ "$HOST_OS" = "win" ]; then
    echo "  node $(PATH="${NODE_BIN_DIR}:${PATH}" "${NODE_BIN}" --version)"
    echo "  npm  $(PATH="${NODE_BIN_DIR}:${PATH}" npm --version 2>/dev/null || echo '(see npm.cmd)')"
    echo "  uv   $(PATH="${UV_BIN_DIR}:${PATH}" uv --version 2>/dev/null || echo '(version unknown)')"
    echo "  prek $(PATH="${PREK_BIN_DIR}:${PATH}" prek --version 2>/dev/null || echo '(version unknown)')"
  else
    echo "  node $(${NODE_BIN_DIR}/node --version)"
    echo "  npm  $(PATH="${NODE_BIN_DIR}:${PATH}" "${NODE_BIN_DIR}/npm" --version)"
    echo "  uv   $(${UV_BIN_DIR}/uv --version 2>/dev/null || echo '(version unknown)')"
    echo "  prek $(${PREK_BIN_DIR}/prek --version 2>/dev/null || echo '(version unknown)')"
  fi
}

persist_ci_path() {
  if [ -n "${GITHUB_PATH:-}" ]; then
    echo "${NODE_BIN_DIR}" >> "$GITHUB_PATH"
    echo "${UV_BIN_DIR}" >> "$GITHUB_PATH"
    echo "${PREK_BIN_DIR}" >> "$GITHUB_PATH"
    echo "  (PATH entries added to \$GITHUB_PATH for subsequent CI steps)"
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────

main() {
  echo "=== Abbenay Bootstrap ==="
  echo ""

  install_node
  validate_sea_fuse
  install_uv
  install_prek
  write_env
  persist_ci_path

  echo ""
  if [ -z "${GITHUB_PATH:-}" ]; then
    echo "Next steps:"
    echo "  source .build-tools/env.sh"
    echo "  npm install"
    echo "  prek install && prek install -t commit-msg  # install git hooks"
    echo "  node build.js"
  fi
}

main
