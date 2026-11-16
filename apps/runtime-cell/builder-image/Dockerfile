# The cell's image builder: upstream rootless BuildKit with two patches
# (README.md): a fix in its overlay differ (overlay-enotsup.patch) and a CA
# bundle every RUN trusts (exec-ca-bundle.patch). Every external stage is a
# multiarch index pinned by digest; buildkitd is cross-compiled from the
# release commit, checked by hash, with upstream's flags.
ARG BUILDKIT_VERSION=v0.34.0
ARG BUILDKIT_COMMIT=f5b59a1f2fb25a0cb7072c398cab9aed7835da4e
# Bumped whenever the patch changes on the same BuildKit release.
ARG KODUS_REVISION=2

# Go and Alpine as upstream's Dockerfile at the release (GO_VERSION=1.26,
# ALPINE_VERSION=3.23).
FROM --platform=$BUILDPLATFORM golang:1.26.11-alpine3.23@sha256:308364e4127bfa2b8d40676ef0b7627584f0f6f9e340f73929b01316fe35a222 AS build
RUN apk add --no-cache git
ARG BUILDKIT_VERSION
ARG BUILDKIT_COMMIT
WORKDIR /src
RUN git init -q . \
 && git fetch -q --depth 1 https://github.com/moby/buildkit "refs/tags/${BUILDKIT_VERSION}" \
 && git -c advice.detachedHead=false checkout -q FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "${BUILDKIT_COMMIT}"
COPY overlay-enotsup.patch exec-ca-bundle.patch /tmp/
RUN for p in overlay-enotsup exec-ca-bundle; do git apply --check "/tmp/$p.patch" && git apply "/tmp/$p.patch" || exit 1; done
ENV GOFLAGS=-mod=vendor CGO_ENABLED=0
# The patches' own tests, on the build platform (the directory test skips where
# no filesystem refuses trusted.* xattrs, as in this build's sandbox).
RUN go test -count=1 -run 'TestXattrAbsent|TestCheckDirectoryWithoutTrustedXattrs' ./util/overlay/ \
 && go test -count=1 -run 'TestExecCABundle' ./executor/oci/
ARG TARGETOS
ARG TARGETARCH
ARG KODUS_REVISION
RUN GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" go build -trimpath -buildvcs=false \
      -ldflags "-X github.com/moby/buildkit/version.Version=${BUILDKIT_VERSION}-kodus.${KODUS_REVISION} -X github.com/moby/buildkit/version.Revision=${BUILDKIT_COMMIT} -X github.com/moby/buildkit/version.Package=github.com/moby/buildkit -extldflags '-static'" \
      -tags "osusergo netgo static_build seccomp" -o /out/buildkitd ./cmd/buildkitd

# Upstream's rootless image of the same release: rootlesskit, buildctl,
# buildctl-daemonless.sh, runc and its user (1000:1000) stay as they are.
FROM moby/buildkit:v0.34.0-rootless@sha256:65eca3c01cd1180c8f64565c4e3c5983af5145818b0e6fa863385d099eb73855
ARG BUILDKIT_VERSION
ARG KODUS_REVISION
COPY --from=build --chmod=755 /out/buildkitd /usr/bin/buildkitd
LABEL org.opencontainers.image.title="kodus-runtime-builder" \
      org.opencontainers.image.description="Rootless BuildKit for the Kody Runtime cell, with the overlay differ fixed for gVisor and a CA bundle every RUN trusts" \
      org.opencontainers.image.source="https://github.com/kodustech/kodus-ai" \
      org.opencontainers.image.version="${BUILDKIT_VERSION}-kodus.${KODUS_REVISION}" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.base.name="docker.io/moby/buildkit:v0.34.0-rootless" \
      org.opencontainers.image.base.digest="sha256:65eca3c01cd1180c8f64565c4e3c5983af5145818b0e6fa863385d099eb73855"
