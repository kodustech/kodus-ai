# Canonical Chromium runner (#2484). All external stages are multiarch indexes.
# The full Playwright image is a file source, never an ancestor of the runtime.
FROM node:22.23.4-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS node-source
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f AS browser-source
# Normalize the upstream cache permissions before the final COPY, so the
# runtime keeps one payload layer and no browser file is writable by its user.
RUN chmod -R go-w /ms-playwright/chromium_headless_shell-1248 /ms-playwright/ffmpeg-1013

FROM node-source AS dependencies
WORKDIR /runner
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node-source AS native-browser-source
ARG TARGETARCH
COPY download-agent-browser.mjs /download-agent-browser.mjs
RUN node /download-agent-browser.mjs /native-browser

FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852 AS runtime
ARG DEBIAN_FRONTEND=noninteractive
# Playwright 1.64.1's Ubuntu 24.04 Chromium dependencies, plus the Node
# runtime/CA/fontconfig closure. Keep the current font families for visual
# evidence; dropping non-Latin fonts is a separate fidelity change.
# https://github.com/microsoft/playwright/blob/v1.64.1/packages/playwright-core/src/server/registry/nativeDeps.ts
RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends \
        ca-certificates fontconfig libatomic1 libgcc-s1 libstdc++6 libudev1 \
        libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 \
        libcairo2 libcups2t64 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 \
        libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 \
        libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
        libfontconfig1 libfreetype6 \
        fonts-freefont-ttf fonts-ipafont-gothic fonts-liberation \
        fonts-noto-color-emoji fonts-tlwg-loma-otf fonts-unifont \
        fonts-wqy-zenhei xfonts-cyrillic xfonts-scalable \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 kody-browser \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin kody-browser

# Copy only the supported runtime binary and its complete bundled notices.
# npm, yarn, headers and the Node source image's layers do not reach final.
COPY --from=node-source /usr/local/bin/node /usr/local/bin/node
COPY --from=node-source /usr/local/LICENSE /usr/share/licenses/kody-browser/node-LICENSE
COPY --from=native-browser-source /native-browser/agent-browser /usr/local/bin/agent-browser
COPY --from=native-browser-source /native-browser/LICENSE /usr/share/licenses/kody-browser/agent-browser-LICENSE
COPY --from=browser-source /ms-playwright/chromium_headless_shell-1248/ /ms-playwright/chromium_headless_shell-1248/
COPY --from=browser-source /ms-playwright/ffmpeg-1013/ /ms-playwright/ffmpeg-1013/

WORKDIR /runner
COPY package.json package-lock.json ./
COPY --from=dependencies /runner/node_modules/ ./node_modules/
COPY tar.mjs steps.mjs run-job.mjs runner.mjs network-guard.mjs ./
COPY agent-browser-client.mjs explore-job.mjs runner-job.mjs agent-browser.json ./

# Keep package copyright files and browser licenses. Record actual APT versions
# rather than implying that a pinned base also freezes the security repository.
RUN mkdir -p /usr/share/kody-browser /usr/share/licenses/kody-browser/ffmpeg \
    && dpkg-query --show --showformat='${binary:Package}\t${Version}\n' > /usr/share/kody-browser/apt-packages.tsv \
    && /ms-playwright/ffmpeg-1013/ffmpeg-linux -L > /usr/share/licenses/kody-browser/ffmpeg/NOTICE 2>&1 \
    && cp /usr/share/common-licenses/LGPL-2.1 /usr/share/licenses/kody-browser/ffmpeg/COPYING.LGPL-2.1 \
    && node --version > /usr/share/kody-browser/node-version.txt \
    && node -p 'require("playwright-core/package.json").version' > /usr/share/kody-browser/playwright-version.txt

RUN /usr/local/bin/agent-browser --version > /usr/share/kody-browser/agent-browser-version.txt \
    && grep -Fx 'agent-browser 0.41.2' /usr/share/kody-browser/agent-browser-version.txt

LABEL io.kodus.browser-explore.protocol="1" \
    io.kodus.agent-browser.version="0.41.2"

ENV HOME=/tmp \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

USER 10001:10001
ENTRYPOINT ["node", "/runner/runner.mjs"]
