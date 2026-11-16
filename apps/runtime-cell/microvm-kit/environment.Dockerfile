# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# The environment microVM's base (microvm-kit/README.md): what a Run's or a
# setup's machine boots on the firecracker backend. Docker, containerd,
# Compose and BuildKit run on the VM's own kernel. The guest agent is added
# by the kit build (kody-kit rootfs -profile environment), which also makes
# /etc/resolv.conf the claim's.
#
# Versions are the P2 spike's (docs/runtime/spike-firecracker-2026-11.md):
# Ubuntu 24.04 by digest, docker.io 29.1.3, BuildKit v0.34.0.
#
# buildkitd is the cell builder's (the `builder` named context, the
# runtime-builder target: builder-image/exec-ca-bundle.patch): a claim whose
# machines trust the cell CA builds with it, so every RUN step trusts the CA
# the injector's leaves are signed with (internal/drivers/microvm/build.go).
# buildx is how compose reaches it.
FROM builder AS kodus-buildkit

FROM docker.io/library/ubuntu:24.04@sha256:2198e4c65076e9cb0b3d695219df667c0e3b0072da64ca3c2648aca17dcecaf5
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      docker.io=29.1.3-0ubuntu3~24.04.2 docker-compose-v2 docker-buildx iptables iproute2 ca-certificates curl git \
      e2fsprogs procps kmod \
 && rm -rf /var/lib/apt/lists/*
# buildctl from the same BuildKit release, by checksum per architecture
# (Apache-2.0), not its bundled emulators; buildkitd is the cell's.
ARG BUILDKIT_VERSION=v0.34.0
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) sum=14813b1fb2a40082114e6d386c6fc5e7dd5298176ce7ee1a18bc33e73e109ac3 ;; \
      arm64) sum=0619ca3e3205a32ea2beb115e0242136e4a0716cc1917ba0ceaa4ef4d52382c9 ;; \
      *) echo "unsupported TARGETARCH '$TARGETARCH'" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/buildkit.tgz "https://github.com/moby/buildkit/releases/download/${BUILDKIT_VERSION}/buildkit-${BUILDKIT_VERSION}.linux-${TARGETARCH}.tar.gz" \
 && echo "${sum}  /tmp/buildkit.tgz" | sha256sum -c - \
 && tar -xzf /tmp/buildkit.tgz -C /usr/local bin/buildctl \
 && rm /tmp/buildkit.tgz \
 && mkdir -p /workspace /var/lib/kody-data
# The cell builder's buildkitd (static), in the place of the release's.
COPY --from=kodus-buildkit /usr/bin/buildkitd /usr/local/bin/buildkitd
