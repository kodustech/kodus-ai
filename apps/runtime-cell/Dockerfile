# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# Kody Runtime cell: every cell binary, static, in one distroless image.
# The Helm chart runs them all from `images.cell` (the reaper CronJob calls
# /usr/local/bin/reaper from that image), so one image, one digest, one
# signature.
#
# Build context: apps/runtime-cell.
#   docker buildx build --platform linux/arm64,linux/amd64 \
#     --build-arg RELEASE_VERSION=runtime-cell/v1.2.3 --build-arg RELEASE_COMMIT=$(git rev-parse HEAD) \
#     -f apps/runtime-cell/Dockerfile apps/runtime-cell
#
# Base images are pinned by digest (S-17); bump the tag and the digest
# together (`docker buildx imagetools inspect <image>:<tag>`). The Go
# version must match the `toolchain` line in go.mod.

# golang:1.27.4-bookworm (multi-arch index)
FROM --platform=$BUILDPLATFORM docker.io/library/golang:1.27.4-bookworm@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea AS build
WORKDIR /src
# Never download another toolchain inside the build: the image is the
# toolchain go.mod asks for.
ENV GOTOOLCHAIN=local \
    GOFLAGS=-mod=readonly \
    CGO_ENABLED=0
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download && go mod verify
COPY cmd ./cmd
COPY internal ./internal
ARG TARGETOS
ARG TARGETARCH
ARG RELEASE_VERSION=dev
ARG RELEASE_COMMIT=
# Cross-compiled on the build platform (no emulation): the binaries are pure
# Go. -trimpath and a stamped version/commit make the output depend only on
# the source and the toolchain.
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    set -eu; mkdir -p /out; \
    pkg=github.com/kodustech/kodus-ai/apps/runtime-cell/internal/version; \
    for c in cell egress resolver injector injector-admin observer reaper; do \
      GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -buildvcs=true \
        -ldflags "-s -w -buildid= -X $pkg.Version=${RELEASE_VERSION} -X $pkg.Commit=${RELEASE_COMMIT}" \
        -o /out/$c ./cmd/$c; \
    done

# No shell, no package manager, non-root. The cell's drivers reach Docker,
# the cloud or Kubernetes through what the deployment mounts.
# gcr.io/distroless/static-debian12:nonroot (multi-arch index)
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/ /usr/local/bin/
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/cell"]
