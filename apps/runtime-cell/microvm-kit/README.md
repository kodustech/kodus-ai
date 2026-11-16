# microVM kit

What the cell's `firecracker` backend boots machines from
([isolation-architecture.md](../../../docs/runtime/isolation-architecture.md), "P2 as built"). One OCI artifact,
signed with cosign, whose only content is `/kit`:

| Path | What | From |
|---|---|---|
| `bin/firecracker`, `bin/jailer` | the VMM and its jailer, the same release | Firecracker v1.18.0 release tarball, by sha256 per arch |
| `kernel/vmlinux`, `kernel/config` | the guest kernel and its config | Linux 6.1.188 from kernel.org, by sha256, built with Firecracker's `microvm-kernel-ci-*-6.1.config` (v1.18.0), unmodified |
| `rootfs/sandbox.ext4` | a code sandbox's root, read-only in the VM | the sandbox tool image (`sandbox-image/`), plus the guest agent as init |
| `rootfs/environment.ext4` | an environment's root | `environment.Dockerfile`: Ubuntu 24.04, docker.io 29.1.3, Compose, buildx, the cell builder's buildkitd (BuildKit v0.34.0 with `builder-image/`'s patches) and the release's buildctl, plus the guest agent |
| `manifest.json` | every file above by path, size and sha256 | `kody-kit manifest` |
| `DIGEST` | `sha256:` of `manifest.json` | the value the cell pins |
| `LICENSES/` | Firecracker's LICENSE, NOTICE, THIRD-PARTY; the kernel's COPYING | the release tarball and the kernel tree |

## Build

```sh
docker buildx bake runtime-microvm-kit                     # from the repository root
docker buildx bake --allow=fs.write=/var/lib/kodus-cell runtime-microvm-kit \
  --set 'runtime-microvm-kit.output=type=local,dest=/var/lib/kodus-cell'   # the kit as files: /var/lib/kodus-cell/kit
```

buildx 0.19 and later refuse a local output outside the working directory without `--allow=fs.write=<dest>`.

The bake builds `runtime-microvm-sandbox` (the sandbox tool image, for the kit's platforms only) and
`runtime-microvm-environment` first and hands them to the kit as named contexts. Both follow
`RUNTIME_MICROVM_PLATFORMS` (`linux/amd64` by default), so an x86_64 host builds the x86_64 kit natively, with no
emulation; `RUNTIME_MICROVM_PLATFORMS=linux/arm64` on an arm64 host builds the arm64 one.
The Go tools, the kernel (cross-compiled) and the ext4 images build on the build platform. `SOURCE_DATE_EPOCH`
stamps the ext4 images, whose UUID and hash seed come from their content.

## Install and verify

The cell verifies the kit at start and refuses it unless `manifest.json` is the pinned digest and every file is its
manifest's size and sha256 (`internal/kit`):

```sh
cosign verify ghcr.io/kodustech/kodus-runtime-microvm-kit@<image digest> \
  --certificate-identity-regexp 'https://github.com/kodustech/kodus-ai/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
docker create --name kit ghcr.io/kodustech/kodus-runtime-microvm-kit@<image digest> /none
docker cp kit:/kit /var/lib/kodus-cell/microvm-kit && docker rm kit
kody-kit verify -dir /var/lib/kodus-cell/microvm-kit -digest "$(cat /var/lib/kodus-cell/microvm-kit/DIGEST)" -arch x86_64
cell -driver docker-gvisor -isolation-backend firecracker \
  -firecracker-kit /var/lib/kodus-cell/microvm-kit -firecracker-kit-digest sha256:<manifest digest from the release notes> ...
```

Pin the manifest digest from the release, not from the `DIGEST` file of the artifact you downloaded.

The cell's egress runs on the host and listens on the egress address the placement keeps on its `kodus-egress` dummy
interface (`-firecracker-egress-address`, default `10.212.255.1`): `egress -listen-tls 10.212.255.1:443 -listen-http
10.212.255.1:80 -dns-listen 10.212.255.1:53 -transparent=false ...`. It is the only address a machine reaches.

Host prerequisites, all named by the cell when one is missing: `/dev/kvm`, root, cgroup v2 with the memory, cpu and
pids controllers, `ip`, `nft`, `sysctl` and `/dev/net/tun`, and a `-firecracker-state-dir` on XFS with `reflink=1` or
on btrfs (machine roots are copy-on-write clones of the kit's images).

## Licenses

| Component | License | How it ships |
|---|---|---|
| Firecracker, jailer | Apache-2.0 | release binaries, unmodified, with their NOTICE and THIRD-PARTY |
| Linux kernel | GPL-2.0-only | a separate binary (`kernel/vmlinux`), never linked with anything else in the kit |
| BuildKit (buildkitd, buildctl) | Apache-2.0 | buildkitd built by `builder-image/` (the release commit plus its two patches), buildctl from the release, in the environment base |
| Docker, containerd, runc, Compose | Apache-2.0 | Ubuntu packages in the environment base |
| The guest agent and kody-kit | the Kodus repository's | built from this repository |
| The rest of each base image's userland (Ubuntu 24.04 and Debian packages: bash, coreutils, iptables, git, e2fsprogs, glibc and others) | their own: GPL-2.0, GPL-3.0, LGPL among them | unmodified distribution packages; their sources are in the Ubuntu and Debian archives at the versions the image lists (`dpkg -l` inside it) |

### Kernel source offer

`kernel/vmlinux` is built from these sources, with no change:

- `https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.1.188.tar.xz`, sha256
  `ed4d0acb1307c235230c89efc094e210e6290593f94a7e617f28b1001101a33a`;
- the configuration `kernel/config` in this kit, made by `make olddefconfig` from Firecracker's
  `resources/guest_configs/microvm-kernel-ci-x86_64-6.1.config` (sha256
  `153ca1b40f3312bfb40b7587b471ea548a915f98f480f0d0892a1537957a2147`) or `microvm-kernel-ci-aarch64-6.1.config`
  (sha256 `5c73202d00b5591ad987d9f808208a318e317fd32dbc17de613c5a93fabe2939`) at tag v1.18.0;
- the build steps in `microvm-kit/Dockerfile`, stage `kernel`.

For at least three years after we last ship this kit, Kodus will give anyone who asks a complete machine-readable copy
of that corresponding source, on a medium customarily used for software interchange, for no more than the cost of
making the copy. Ask through https://github.com/kodustech/kodus-ai/issues or the contact on kodus.io.
