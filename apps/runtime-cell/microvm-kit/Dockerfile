# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# The microVM kit (microvm-kit/README.md, internal/kit): what the cell's
# firecracker backend boots machines from, as one OCI artifact holding /kit:
#
#   bin/firecracker bin/jailer        Firecracker's release, by checksum
#   kernel/vmlinux kernel/config      the guest kernel, built from kernel.org's
#                                     tarball with Firecracker's guest config
#   rootfs/sandbox.ext4               the sandbox tool image (runtime-sandbox)
#   rootfs/environment.ext4           the environment base (environment.Dockerfile)
#   manifest.json DIGEST              every file by size and sha256; DIGEST is
#                                     the manifest's, the value the cell pins
#   README.md LICENSES/
#
# Build context: apps/runtime-cell, with two named contexts, sandbox and
# environment. From the repository root:
#   docker buildx bake runtime-microvm-kit         (docker-bake.hcl)
# Every download is pinned by sha256. The Go tools, the kernel and the
# ext4 images build on the build platform; only their target differs.

ARG FIRECRACKER_VERSION=v1.18.0
ARG KERNEL_VERSION=6.1.188
# The sha256 of each download at the versions above. A new version comes with
# its own sums (scripts/runtime/kit-rebuild.sh passes both).
ARG FIRECRACKER_SHA256_X86_64=1ac8eec866dd5eea14efecf6323e22b23eea24054545338a5b34bc5bca6623cd
ARG FIRECRACKER_SHA256_AARCH64=2a6130ff0338901ff9d7fbd73ce046c6b1c6123889dc84a34d678aa53bd0c0c2
ARG KERNEL_SHA256=ed4d0acb1307c235230c89efc094e210e6290593f94a7e617f28b1001101a33a
ARG GUEST_CONFIG_SHA256_X86_64=153ca1b40f3312bfb40b7587b471ea548a915f98f480f0d0892a1537957a2147
ARG GUEST_CONFIG_SHA256_AARCH64=5c73202d00b5591ad987d9f808208a318e317fd32dbc17de613c5a93fabe2939

FROM --platform=$BUILDPLATFORM docker.io/library/golang:1.27.4-bookworm@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea AS tools
WORKDIR /src
ENV GOTOOLCHAIN=local GOFLAGS=-mod=readonly CGO_ENABLED=0
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download && go mod verify
COPY cmd ./cmd
COPY internal ./internal
ARG TARGETARCH
ARG BUILDARCH
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    GOOS=linux GOARCH=$TARGETARCH go build -trimpath -ldflags=-buildid= -o /out/target/kody-guest ./cmd/kody-guest \
 && GOOS=linux GOARCH=$BUILDARCH go build -trimpath -ldflags=-buildid= -o /out/build/kody-kit ./cmd/kody-kit

FROM --platform=$BUILDPLATFORM docker.io/library/debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS firecracker
ARG FIRECRACKER_VERSION
ARG FIRECRACKER_SHA256_X86_64
ARG FIRECRACKER_SHA256_AARCH64
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in \
      amd64) a=x86_64; sum=$FIRECRACKER_SHA256_X86_64 ;; \
      arm64) a=aarch64; sum=$FIRECRACKER_SHA256_AARCH64 ;; \
      *) echo "unsupported TARGETARCH '$TARGETARCH'" >&2; exit 1 ;; \
    esac \
 && v=$FIRECRACKER_VERSION \
 && curl -fsSL -o /tmp/fc.tgz "https://github.com/firecracker-microvm/firecracker/releases/download/${v}/firecracker-${v}-${a}.tgz" \
 && echo "${sum}  /tmp/fc.tgz" | sha256sum -c - \
 && tar -xzf /tmp/fc.tgz -C /tmp \
 && d=/tmp/release-${v}-${a} \
 && (cd "$d" && sha256sum -c --ignore-missing SHA256SUMS) \
 && install -D -m0755 "$d/firecracker-${v}-${a}" /out/bin/firecracker \
 && install -D -m0755 "$d/jailer-${v}-${a}" /out/bin/jailer \
 && install -D -m0644 -t /out/LICENSES/firecracker "$d/LICENSE" "$d/NOTICE" "$d/THIRD-PARTY"

# The guest kernel: kernel.org's tarball and Firecracker's own guest config
# for that series (microvm-kernel-ci-*-6.1.config at the release's tag),
# unmodified, cross-compiled. The source offer is in README.md.
FROM --platform=$BUILDPLATFORM docker.io/library/debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS kernel
ARG FIRECRACKER_VERSION
ARG KERNEL_VERSION
ARG KERNEL_SHA256
ARG GUEST_CONFIG_SHA256_X86_64
ARG GUEST_CONFIG_SHA256_AARCH64
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils make bc bison flex libelf-dev libssl-dev gcc libc6-dev \
      gcc-x86-64-linux-gnu gcc-aarch64-linux-gnu python3 \
 && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in \
      amd64) a=x86_64; karch=x86_64; cross=x86_64-linux-gnu-; image=vmlinux; csum=$GUEST_CONFIG_SHA256_X86_64 ;; \
      arm64) a=aarch64; karch=arm64; cross=aarch64-linux-gnu-; image=arch/arm64/boot/Image; csum=$GUEST_CONFIG_SHA256_AARCH64 ;; \
      *) echo "unsupported TARGETARCH '$TARGETARCH'" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/linux.tar.xz "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${KERNEL_VERSION}.tar.xz" \
 && echo "${KERNEL_SHA256}  /tmp/linux.tar.xz" | sha256sum -c - \
 && curl -fsSL -o /tmp/guest.config "https://raw.githubusercontent.com/firecracker-microvm/firecracker/${FIRECRACKER_VERSION}/resources/guest_configs/microvm-kernel-ci-${a}-6.1.config" \
 && echo "${csum}  /tmp/guest.config" | sha256sum -c - \
 && mkdir /tmp/src && tar -xJf /tmp/linux.tar.xz -C /tmp/src --strip-components=1 \
 && cd /tmp/src && cp /tmp/guest.config .config \
 && export KBUILD_BUILD_TIMESTAMP="1970-01-01" KBUILD_BUILD_USER=kodus KBUILD_BUILD_HOST=kodus \
 && make ARCH="$karch" CROSS_COMPILE="$cross" olddefconfig \
 && make ARCH="$karch" CROSS_COMPILE="$cross" -j"$(nproc)" "$(basename "$image")" \
 && install -D -m0644 "$image" /out/kernel/vmlinux \
 && install -D -m0644 .config /out/kernel/config \
 && install -D -m0644 COPYING /out/LICENSES/linux/COPYING \
 && rm -rf /tmp/src /tmp/linux.tar.xz

FROM sandbox AS sandbox-image
FROM environment AS environment-image

# The two base root file systems: each image's files as one tar (owners and
# modes kept by --numeric-owner), turned into ext4 with the guest agent as
# init by kody-kit (internal/rootfs).
FROM --platform=$BUILDPLATFORM docker.io/library/debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS rootfs
RUN apt-get update && apt-get install -y --no-install-recommends e2fsprogs libarchive13t64 tar && rm -rf /var/lib/apt/lists/*
COPY --from=tools /out/target/kody-guest /usr/local/lib/kody/kody-guest
COPY --from=tools /out/build/kody-kit /usr/local/bin/kody-kit
ARG SOURCE_DATE_EPOCH=0
RUN --mount=type=bind,from=sandbox-image,target=/img \
    tar --numeric-owner --xattrs --sort=name -C /img -cf /tmp/sandbox.tar . \
 && mkdir -p /out/rootfs \
 && SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH kody-kit rootfs -tar /tmp/sandbox.tar -profile sandbox -guest /usr/local/lib/kody/kody-guest -out /out/rootfs/sandbox.ext4 \
 && rm /tmp/sandbox.tar
RUN --mount=type=bind,from=environment-image,target=/img \
    tar --numeric-owner --xattrs --sort=name -C /img -cf /tmp/environment.tar . \
 && SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH kody-kit rootfs -tar /tmp/environment.tar -profile environment -guest /usr/local/lib/kody/kody-guest -out /out/rootfs/environment.ext4 \
 && rm /tmp/environment.tar

FROM --platform=$BUILDPLATFORM docker.io/library/debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS assemble
COPY --from=firecracker /out/ /kit/
COPY --from=kernel /out/ /kit/
COPY --from=rootfs /out/ /kit/
COPY microvm-kit/README.md /kit/README.md
COPY --from=tools /out/build/kody-kit /usr/local/bin/kody-kit
ARG FIRECRACKER_VERSION
ARG KERNEL_VERSION
ARG TARGETARCH
RUN case "$TARGETARCH" in amd64) a=x86_64 ;; arm64) a=arm64 ;; esac \
 && kody-kit manifest -dir /kit -arch "$a" -firecracker-version "$FIRECRACKER_VERSION" -kernel-version "$KERNEL_VERSION" > /kit/DIGEST \
 && kody-kit verify -dir /kit -digest "$(cat /kit/DIGEST)" -arch "$a"

FROM scratch
LABEL org.opencontainers.image.source="https://github.com/kodustech/kodus-ai" \
      org.opencontainers.image.title="Kodus Runtime microVM kit" \
      org.opencontainers.image.licenses="AGPL-3.0-only AND Apache-2.0 AND GPL-2.0-only AND MIT AND LGPL-2.0-or-later"
COPY --from=assemble /kit /kit
