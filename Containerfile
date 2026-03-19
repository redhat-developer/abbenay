# Abbenay — Multi-stage container build
#
# Build:   podman build -f Containerfile -t abbenay:latest .
# Run:     podman run -d -p 8787:8787 \
#            -v ./config.yaml:/home/abbenay/.config/abbenay/config.yaml:ro \
#            -e OPENROUTER_API_KEY=sk-... \
#            abbenay:latest
#
# See docs/CONTAINER.md for full documentation.

# ---------------------------------------------------------------------------
# Stage 1: Build the SEA binary and sidecars
# ---------------------------------------------------------------------------
FROM registry.access.redhat.com/ubi9/nodejs-22:latest AS builder

USER 0

# Python + pip are needed for grpc_tools.protoc (Python client proto generation).
# System protoc is not required — the TS stage gracefully skips when absent.
RUN dnf install -y --nodocs python3 python3-pip xz && \
    dnf clean all

WORKDIR /build
COPY . .

# Download an official nodejs.org binary for SEA injection.  The UBI9
# Node.js package doesn't contain the NODE_SEA_FUSE sentinel required
# to produce a Single Executable Application.
ARG TARGETARCH
RUN node_arch=$([ "$TARGETARCH" = "amd64" ] && echo "x64" || echo "${TARGETARCH:-$(node -p process.arch)}") && \
    node_version=$(cat .node-version | tr -d '[:space:]') && \
    mkdir -p /build/.sea-node && \
    curl -fsSL "https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-${node_arch}.tar.xz" \
      | tar xJ --strip-components=1 -C /build/.sea-node && \
    grep -q 'NODE_SEA_FUSE' /build/.sea-node/bin/node

RUN npm ci --ignore-scripts && \
    npx node-gyp rebuild --directory node_modules/keytar 2>/dev/null || true

RUN node_arch=$([ "$TARGETARCH" = "amd64" ] && echo "x64" || echo "${TARGETARCH:-$(node -p process.arch)}") && \
    export NODE_SEA_BASE="/build/.sea-node/bin/node" && \
    node build.js

# Copy the platform-specific binary to a fixed path for the runtime stage.
RUN node_arch=$([ "$TARGETARCH" = "amd64" ] && echo "x64" || echo "${TARGETARCH:-$(node -p process.arch)}") && \
    cp packages/daemon/dist/sea/abbenay-daemon-linux-${node_arch} /build/abbenay-binary

# ---------------------------------------------------------------------------
# Stage 2: Minimal runtime image
# ---------------------------------------------------------------------------
FROM registry.access.redhat.com/ubi9/ubi-minimal:latest

ARG APP_USER=abbenay
ARG APP_UID=1001
ARG VERSION=dev

LABEL org.opencontainers.image.title="Abbenay" \
      org.opencontainers.image.description="AI provider gateway — web dashboard, REST/OpenAI API, gRPC, and MCP server" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/redhat-developer/abbenay" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="Red Hat"

RUN microdnf install -y shadow-utils curl-minimal && \
    useradd -u ${APP_UID} -m ${APP_USER} && \
    microdnf clean all

WORKDIR /opt/abbenay

# Copy SEA binary and required sidecars (proto + static assets).
# keytar.node is intentionally excluded — it requires D-Bus / libsecret
# which are unavailable in containers.  Use api_key_env_var_name in config
# instead of api_key_keychain_name.
COPY --from=builder /build/abbenay-binary ./abbenay
COPY --from=builder /build/packages/daemon/dist/sea/proto/ ./proto/
COPY --from=builder /build/packages/daemon/dist/sea/static/ ./static/

RUN chmod 755 ./abbenay && \
    mkdir -p /home/${APP_USER}/.config/abbenay && \
    chown -R ${APP_USER}:${APP_USER} /home/${APP_USER}

USER ${APP_USER}

EXPOSE 8787 50051

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:8787/api/health || exit 1

ENTRYPOINT ["./abbenay"]
CMD ["start", "--port", "8787", "--grpc-port", "50051", "--grpc-host", "0.0.0.0"]
