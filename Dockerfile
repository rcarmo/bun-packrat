FROM oven/bun:1.4.0 AS base

# ── System dependencies ───────────────────────────────────────────────────
# Playwright Chromium headless-shell dependencies (Debian slim base)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gosu \
    # Chromium runtime libs
    libnspr4 libnss3 libdbus-1-3 \
    libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
    libcups2 libdrm2 libgbm1 \
    libxkbcommon0 libxcomposite1 libxdamage1 \
    libxext6 libxfixes3 libxrandr2 \
    libpango-1.0-0 libcairo2 libasound2 \
    libx11-6 libxcb1 libx11-xcb1 \
    # Fonts for legible captures
    fonts-liberation fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

# ── Application ───────────────────────────────────────────────────────────
WORKDIR /app

# Install Node/Bun dependencies first (cache layer)
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

# Install Playwright Chromium browser binaries into /browsers
# (baked into image — no network fetch at runtime)
ENV PLAYWRIGHT_BROWSERS_PATH=/browsers
RUN bun --bun node_modules/.bin/playwright install chromium chromium-headless-shell

# Copy source
COPY src ./src
COPY docs ./docs
COPY docker ./docker
COPY README.md LICENSE ./

RUN chmod +x /app/docker/entrypoint.sh

# ── Environment defaults ───────────────────────────────────────────────────
ENV HOST=0.0.0.0 \
    PORT=3047 \
    PACKRAT_DB=/data/packrat.db \
    PLAYWRIGHT_BROWSERS_PATH=/browsers \
    PACKRAT_CAPTURE_TIMEOUT_MS=60000 \
    PACKRAT_MAX_PAGE_BYTES=20971520 \
    PACKRAT_MAX_ASSET_BYTES=5242880 \
    PACKRAT_MAX_PDF_BYTES=104857600 \
    PACKRAT_PDF_EXTRACTION_TIMEOUT_MS=60000 \
    PACKRAT_MAX_PDF_PAGES=1000 \
    PACKRAT_MAX_PDF_TEXT_BYTES=10485760 \
    PACKRAT_HTML_COMPRESSION=auto \
    PACKRAT_MAX_CONCURRENT_CAPTURES=2 \
    PACKRAT_FRESHNESS_SECONDS=86400 \
    PACKRAT_AUTH_USER=packrat \
    PACKRAT_AUTH_DISABLED=0 \
    PACKRAT_BASE_URL=http://localhost:3047

EXPOSE 3047

VOLUME ["/data"]

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["bun", "--no-orphans", "run", "src/server.ts"]
