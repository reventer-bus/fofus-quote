# ────────────────────────────────────────────────────────────────────
# FOFUS Quote backend — Dockerfile for Railway (repo-root build context)
# ────────────────────────────────────────────────────────────────────
# Multi-stage build:
#   1. Builder:    npm install (backend deps)
#   2. Runtime:    node + orca-slicer AppImage + FUSE + headless X + OpenGL
# Build context must be the repo root so it can COPY both backend/ and frontend/.
# ────────────────────────────────────────────────────────────────────

# ── Stage 1: deps ────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY backend/package.json backend/package-lock.json* ./
RUN npm ci --omit=dev

# ── Stage 2: runtime ────────────────────────────────────────────────
FROM ubuntu:24.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PORT=3000 \
    NODE_ENV=production \
    SLICER_BIN=/usr/local/bin/orca-slicer-xvfb \
    SLICER_VERSION=2.3.1 \
    SLICER_APPIMAGE=OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.3.1.AppImage

# System deps for the Ubuntu 24.04 OrcaSlicer AppImage + headless slicing.
# libgconf-2-4 was dropped in 24.04 and is not required by this CLI path.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl fuse3 libfuse2 \
    libgtk-3-0 libnss3 libgbm1 libasound2t64 libxss1 \
    libxshmfence1 libxcomposite1 libxdamage1 libxrandr2 \
    libpango-1.0-0 libcairo2 libcups2 libatk1.0-0 libatk-bridge2.0-0 \
    libdrm2 libxkbcommon0 fonts-liberation \
    libgl1 libgl1-mesa-dri libglx0 libegl1 xvfb xauth \
    libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 libgstreamer-plugins-bad1.0-0 \
    gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly gstreamer1.0-libav gstreamer1.0-pulseaudio libpulse0 \
    libwebkit2gtk-4.1-0 libjavascriptcoregtk-4.1-0 libsecret-1-0 libsoup-3.0-0 \
    libayatana-appindicator3-1 libnotify4 \
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
    ln -sf /opt/orca-slicer/AppRun /usr/local/bin/orca-slicer && \
    # Wrap with xvfb-run so the slicer has a headless display in Railway
    printf '%s\n' '#!/bin/sh' 'exec xvfb-run -a /opt/orca-slicer/AppRun "$@"' > /usr/local/bin/orca-slicer-xvfb && \
    chmod +x /usr/local/bin/orca-slicer-xvfb && \
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
