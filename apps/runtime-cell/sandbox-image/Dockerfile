# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# The code sandbox's tool image (docs/runtime/sandbox.md): what Kody's
# review and custom agents run in a sandbox claim on a cell, with the guest
# agent (cmd/kody-guest) that serves the cell's sandbox.op frames inside it.
#
# The cell starts it read-only, as user 1000, no capability, no new
# privileges, under runsc, with /workspace and /tmp in the sandbox's own
# memory (dockercli.SandboxArgs); the guest agent runs on a docker exec -i
# stream. The tools are the ones the review's sandbox commands use, pinned to
# the versions of docker/Dockerfile and e2b-sandbox/template.ts so the three
# sandboxes run the same analyzers: git, ripgrep, ast-grep, betterleaks,
# osv-scanner, kodus-graph (bun), node, python3, coreutils, findutils, sed.
#
# Supply chain: every base image is pinned by digest (the multi-arch index,
# Docker Hub), every GitHub-release download by sha256 (each project's own
# checksum file where it publishes one, else GitHub's asset digest), and the
# kodus-graph tarball by the npm registry's sha512 integrity. A version bump
# changes its digest or checksum in the same edit, or the build fails.
# Residual: kodus-graph's own dependencies are still resolved from the npm
# registry by their semver ranges (bun install of the verified tarball); only
# the top-level package is pinned.
#
# Build context: apps/runtime-cell. From the repository root:
#   docker buildx bake runtime-sandbox            (docker-bake.hcl, both platforms)
#   docker buildx build -f apps/runtime-cell/sandbox-image/Dockerfile apps/runtime-cell

ARG BUN_VERSION=1.2.12
# The oven/bun:${BUN_VERSION}-debian index.
ARG BUN_IMAGE_DIGEST=sha256:0bba4be157f03bc63740b9acb9523233541368e3c4e44317c6d1913ab752fd34

# golang:1.27.4-bookworm (multi-arch index), as apps/runtime-cell/Dockerfile.
FROM --platform=$BUILDPLATFORM docker.io/library/golang:1.27.4-bookworm@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea AS guest
WORKDIR /src
ENV GOTOOLCHAIN=local GOFLAGS=-mod=readonly CGO_ENABLED=0
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download && go mod verify
COPY cmd ./cmd
COPY internal ./internal
ARG TARGETOS
ARG TARGETARCH
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -o /out/kody-guest ./cmd/kody-guest

FROM docker.io/oven/bun:${BUN_VERSION}-debian@${BUN_IMAGE_DIGEST} AS bun-source

# debian:bookworm-slim (multi-arch index).
FROM --platform=$BUILDPLATFORM docker.io/library/debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS analyzers
ARG TARGETARCH
# Each sha256 is of that version's file: bump them together.
#   betterleaks: the release's checksums.txt;
#   osv-scanner: the release's osv-scanner_SHA256SUMS;
#   ast-grep: publishes no checksum file; GitHub's asset digest
#     (api.github.com/repos/ast-grep/ast-grep/releases/tags/<version>).
ARG BETTERLEAKS_VERSION=1.8.1
ARG BETTERLEAKS_SHA256_AMD64=efa407244e1ea8e35f582b8a42becdeac08bdead04f68eb752adda722d583c2a
ARG BETTERLEAKS_SHA256_ARM64=bbb578b12a2f65d7082ab436abf37724232bc71d8a078e3c41336574420f1b48
ARG OSV_SCANNER_VERSION=2.6.0
ARG OSV_SCANNER_SHA256_AMD64=ca69b3d3cd08f889a49dc0a383122f71cc528b83803671df5fd874d97485b108
ARG OSV_SCANNER_SHA256_ARM64=2c71403eb443d05891c4f268c3ad771cf4f16e5443463fd7851ef8f454d3c7e4
ARG AST_GREP_VERSION=0.45.3
ARG AST_GREP_SHA256_AMD64=f8ac830881339d1edee6b2652f54798c0f4da5a827f2db38a08ee31117783ce8
ARG AST_GREP_SHA256_ARM64=b39cfbc58da4b869a88b8a4bc57bd5deb0d24541e704cf7c257da7b53ec81c8f
# kodus-graph's npm tarball: the registry's dist.integrity
# (sha512-NBp+BAW0/LIdqqhJezVK6i7L5wECxzifjFlISgBwmxHgJF4pYs0t2gT6qHYneM7qMK8tF3Vuh9DhXh8n66Yf1A==),
# in hex.
ARG KODUS_GRAPH_VERSION=0.3.0
ARG KODUS_GRAPH_SHA512=341a7e0405b4fcb21daaa8497b354aea2ecbe70102c7389f8c59484a00709b11e0245e2962cd2dda04faa8762778ceea30af2d17756e87d0e15e1f27eba61fd4
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && case "$TARGETARCH" in \
       amd64) bl=linux_x64; ag=x86_64; bl_sum=$BETTERLEAKS_SHA256_AMD64; osv_sum=$OSV_SCANNER_SHA256_AMD64; ag_sum=$AST_GREP_SHA256_AMD64 ;; \
       arm64) bl=linux_arm64; ag=aarch64; bl_sum=$BETTERLEAKS_SHA256_ARM64; osv_sum=$OSV_SCANNER_SHA256_ARM64; ag_sum=$AST_GREP_SHA256_ARM64 ;; \
       *) echo "unsupported TARGETARCH '$TARGETARCH'" >&2; exit 1 ;; \
     esac \
  && curl -fsSL -o /tmp/betterleaks.tgz \
       "https://github.com/betterleaks/betterleaks/releases/download/v${BETTERLEAKS_VERSION}/betterleaks_${BETTERLEAKS_VERSION}_${bl}.tar.gz" \
  && echo "${bl_sum}  /tmp/betterleaks.tgz" | sha256sum -c - \
  && tar -xzf /tmp/betterleaks.tgz -C / betterleaks \
  && curl -fsSL -o /osv-scanner \
       "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_linux_${TARGETARCH}" \
  && echo "${osv_sum}  /osv-scanner" | sha256sum -c - \
  && curl -fsSL -o /tmp/ast-grep.zip \
       "https://github.com/ast-grep/ast-grep/releases/download/${AST_GREP_VERSION}/app-${ag}-unknown-linux-gnu.zip" \
  && echo "${ag_sum}  /tmp/ast-grep.zip" | sha256sum -c - \
  && unzip -o /tmp/ast-grep.zip ast-grep -d / \
  && chmod +x /betterleaks /osv-scanner /ast-grep \
  && curl -fsSL -o /kodus-graph.tgz \
       "https://registry.npmjs.org/@kodus/kodus-graph/-/kodus-graph-${KODUS_GRAPH_VERSION}.tgz" \
  && echo "${KODUS_GRAPH_SHA512}  /kodus-graph.tgz" | sha512sum -c - \
  && chmod 0644 /kodus-graph.tgz

# node:22.23.4-slim (multi-arch index), as browser-runner/Dockerfile.
FROM docker.io/library/node:22.23.4-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
LABEL org.opencontainers.image.source="https://github.com/kodustech/kodus-ai"
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep python3 procps \
  && rm -rf /var/lib/apt/lists/*
COPY --from=bun-source /usr/local/bin/bun /usr/local/bin/bun
COPY --from=analyzers /betterleaks /osv-scanner /ast-grep /usr/local/bin/
COPY --from=guest /out/kody-guest /usr/local/bin/kody-guest
USER 1000
# The verified tarball, not the name: bun would fetch the name again. Bound,
# not copied, so it stays out of the image's layers.
RUN --mount=type=bind,from=analyzers,source=/kodus-graph.tgz,target=/tmp/kodus-graph.tgz \
    BUN_INSTALL=/home/node/.bun bun install -g /tmp/kodus-graph.tgz
USER root
RUN printf '%s\n' '#!/bin/sh' 'exec /home/node/.bun/bin/kodus-graph "$@"' > /usr/local/bin/kodus-graph \
  && chmod 0755 /usr/local/bin/kodus-graph \
  # No way to become root inside: no set-id file is left (the container
  # also runs with no-new-privileges and no capability).
  && find / -xdev -type f -perm /6000 -exec chmod ug-s {} + \
  && test -z "$(find / -xdev -type f -perm /6000 -print -quit)"
# The root file system is read-only at run time: home and caches live in /tmp.
ENV HOME=/tmp PATH=/home/node/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER 1000
WORKDIR /workspace
CMD ["sleep", "infinity"]
