# Debian (glibc) base on both stages: better-sqlite3 is a native module and
# Playwright's chromium (used by the cookie-auth WebCDP capture flow) targets
# glibc/Debian, not Alpine/musl. Keeping both stages on the same libc avoids
# native-ABI mismatches when node_modules is copied across.
FROM node:26-bookworm-slim AS builder
WORKDIR /app
# Browsers are installed in the runtime stage, not here.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# Toolchain for native deps (better-sqlite3) in case no prebuild matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package*.json turbo.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/portal/package.json ./packages/portal/
RUN npm ci
# npm nests a workspace's dependency under packages/<pkg>/node_modules whenever
# it cannot hoist to the root. Guarantee the directory exists so the runtime
# stage can copy it unconditionally.
RUN mkdir -p /app/packages/server/node_modules
COPY . .
# No Chromium in this stage to render the brand PNGs; skip that step and let
# the portal build fall back to the committed copies under docs/assets/brand.
ENV BRAND_SKIP_PNG=1
RUN npm run build

FROM node:26-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=builder /app/packages/server/dist ./server
# The version shown on the admin Overview, and sent to custom MCP servers, is
# read from the root package.json. Nothing else in the image carries it.
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
# Copying only the root tree assumed npm always hoists. It does not: a version
# that cannot hoist stays under the workspace, and v0.26.0 shipped without
# tar-stream or the OpenTelemetry SDK because of it. Node resolves
# server/node_modules before /app/node_modules, so the nested tree lands where
# the compiled server actually looks for it.
COPY --from=builder /app/packages/server/node_modules ./server/node_modules
# node_modules/@a-workbench/* are workspace symlinks into packages/, which isn't
# shipped — they dangle. Drop them and ship @a-workbench/shared (the only one the
# server imports) as a real package so its `main` resolves cleanly.
RUN rm -rf node_modules/@a-workbench
COPY --from=builder /app/packages/shared/package.json ./node_modules/@a-workbench/shared/package.json
COPY --from=builder /app/packages/shared/dist ./node_modules/@a-workbench/shared/dist
COPY --from=builder /app/packages/portal/dist ./portal
COPY --from=builder /app/packages/plugins ./plugins
# Browser audio pipeline: a PulseAudio daemon (child of the server) gives each
# user's chromium a private virtual speaker and mic. Idle unless
# BROWSER_AUDIO_ENABLED is set. See docs/guides/browser-audio.
RUN apt-get update \
 && apt-get install -y --no-install-recommends pulseaudio pulseaudio-utils \
 && rm -rf /var/lib/apt/lists/*
# Cookie-auth capture spawns chromium via playwright's chromium.executablePath().
# Bake the matching browser + its system libraries into the image so the flow
# works headless in-container. Installed world-readable so any runtime uid works.
RUN npx playwright install --with-deps chromium \
 && chmod -R a+rx /ms-playwright
RUN npm install -g tsx@4.19.4
EXPOSE 3000
CMD ["tsx", "server/index.js"]
