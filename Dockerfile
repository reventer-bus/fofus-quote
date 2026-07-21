# ────────────────────────────────────────────────────────────────────
# FOFUS Quote backend — Dockerfile for Railway (repo-root build context)
# ────────────────────────────────────────────────────────────────────
# Multi-stage build:
#   1. Builder:    npm install (backend deps)
#   2. Runtime:    node + orca-slicer AppImage + FUSE
# Build context must be the repo root so it can COPY both backend/ and frontend/.
# ────────────────────────────────────────────────────────────────────

# ── Stage 1: deps ────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY backend/package.json backend/package-lock.json* ./
RUN npm ci --omit=dev

# ── Stage 2: runtime ────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PORT=3000 \
    NODE_ENV=production \
    SLICER_BIN=/usr/local/bin/orca-slicer \
    SLICER_VERSION=2.3.1 \
    SLICER_APPIMAGE=OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.3.1.AppImage

# System deps:
#   - fuse3: required to run the OrcaSlicer AppImage
#   - libfuse2: AppImage uses libfuse2 (older API)
#   - libgtk-3-0 / libnss3 / libgbm1: OrcaSlicer GTK runtime
#   - libssl3 / libcurl4 / ca-certificates: misc
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl fuse3 libfuse2 \
    libgtk-3-0 libnss3 libgbm1 libasound2 libxss1 \
    libxshmfence1 libxcomposite1 libxdamage1 libxrandr2 \
    libpango-1.0-0 libcairo2 libcups2 libatk1.0-0 libatk-bridge2.0-0 \
    libdrm2 libgconf-2-4 libxkbcommon0 fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# Install Node 20 from NodeSource (must match builder stage for native modules)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Install OrcaSlicer AppImage
# (Railway's container is amd64; ARM users should override --platform)
ARG TARGETARCH=amd64
RUN if [ "$TARGETARCH" = "arm64" ]; then \
      echo "OrcaSlicer AppImage only ships for x86_64. Use amd64 on Railway." && exit 1; \
    fi && \
    curl -fsSL -o /tmp/orca.AppImage \
      https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v${SLICER_VERSION}/${SLICER_APPIMAGE} && \
    chmod +x /tmp/orca.AppImage && \
    # Extract AppImage so we don't need FUSE at runtime — much faster startup.
    cd /tmp && ./orca.AppImage --appimage-extract >/dev/null 2>&1 && \
    mv /tmp/squashfs-root /opt/orca-slicer && \
    ln -sf /opt/orca-slicer/AppRun ${SLICER_BIN} && \
    rm -f /tmp/orca.AppImage

# App
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY backend/package.json ./
COPY backend/src ./src
COPY backend/profiles ./profiles
COPY frontend ./frontend

# Railway: use Railway Volumes instead of Docker VOLUME directive
# Create data dirs (Railway volume mounts at /app/data at runtime)
RUN mkdir -p /app/data/uploads /app/data/sliced

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:${PORT}/api/health || exit 1

CMD ["node", "src/server.js"]
