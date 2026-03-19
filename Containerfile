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

# Install protobuf compiler and Python for proto generation
RUN dnf install -y --nodocs protobuf-compiler python3 python3-pip && \
    dnf clean all

WORKDIR /build
COPY . .

RUN npm ci --ignore-scripts && \
    npx node-gyp rebuild --directory node_modules/keytar 2>/dev/null || true && \
    node build.js

# ---------------------------------------------------------------------------
# Stage 2: Minimal runtime image
# ---------------------------------------------------------------------------
FROM registry.access.redhat.com/ubi9/ubi-minimal:latest

ARG APP_USER=abbenay
ARG APP_UID=1001

RUN microdnf install -y shadow-utils curl-minimal && \
    useradd -u ${APP_UID} -m ${APP_USER} && \
    microdnf clean all

WORKDIR /opt/abbenay

# Copy SEA binary and required sidecars (proto + static assets).
# keytar.node is intentionally excluded — it requires D-Bus / libsecret
# which are unavailable in containers.  Use api_key_env_var_name in config
# instead of api_key_keychain_name.
COPY --from=builder /build/packages/daemon/dist/sea/abbenay-daemon-linux-x64 ./abbenay
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
