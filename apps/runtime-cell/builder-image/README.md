# Image builder

The image the cell runs to build a project's `build:` sections under gVisor (`-gvisor-builder-image`). It is
upstream's rootless BuildKit with two changes, in `buildkitd` only: `overlay-enotsup.patch` and `exec-ca-bundle.patch`.
Everything else in the image (rootlesskit, buildctl, `buildctl-daemonless.sh`, runc, user 1000:1000) is the upstream
image, pinned by digest.

## Why: overlay-enotsup.patch

BuildKit's overlay differ reads the `trusted.overlay.redirect` and `trusted.overlay.opaque` xattrs of each directory a
layer changed. Under gVisor, the gofer answers `getxattr("trusted.*")` with `ENOTSUP`, and `util/overlay` accepted
only `ENODATA` as "not set". So every new layer failed with `failed to retrieve trusted.overlay.redirect attr:
operation not supported` and BuildKit fell back to the double-walking differ over the whole tree. On twenty that is
630 s of "exporting layers", 35 s with the patch, with identical layer contents
(measured on the dev cell, 2026-11-11).

The patch treats `ENOTSUP` like `ENODATA`: a filesystem that cannot hold the attribute does not have it set. It adds
two tests, which the Dockerfile runs before it builds `buildkitd`.

## Why: exec-ca-bundle.patch

The cell inspects a claim's TLS to a registry (GET and HEAD under its paths, a publish refused) by ending it at the
injector with a leaf of the cell CA. A machine trusts that CA through the cell's bundle; a Dockerfile's RUN steps kept
their base image's trust store, so the cell could not inspect a build and had to refuse its TLS to every registry
(docs/runtime/egress-allowlist.md §16). Nothing in upstream BuildKit gives every RUN a CA without the Dockerfile asking:
`buildkitd.toml`'s `ca` is for registry connections, a CDI device reaches a step only through `RUN --device`, and the
only undeclared build args are the proxy ones.

The patch adds one OCI worker option, `[worker.oci] execCABundle = "<file>"` (the public roots and the extra CA, one PEM
file). With it, every exec of the runc executor (each RUN, and an exec into a gateway container) gets:

- the file bind-mounted read-only at `/run/buildkit/ca-bundle.pem`, next to the SSH agent sockets BuildKit already
  mounts there. The mount point is a stub runc makes; BuildKit's own stub cleaner removes it (and `/run/buildkit` when
  the image had none), so it never reaches a layer;
- `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `PIP_CERT`, `CURL_CA_BUNDLE` and `GIT_SSL_CAINFO`
  pointed at it, each unless the exec already has it (an `ENV` of the image or the Dockerfile, a declared build arg):
  as with the tracing variables, a Dockerfile that sets its own trust keeps it. These are process variables of the
  exec, not of the image: no image config and no cache key changes.

`buildkitd` refuses to start when the file is not a regular file it can read. The containerd worker is unchanged (the
cell runs the OCI worker only). The patch adds three tests (`TestExecCABundle*` in `executor/oci`), which the
Dockerfile runs with the overlay ones.

A tool that reads none of those variables (apt over HTTPS and wget built with GnuTLS read their own CA paths, the JVM
its `cacerts`) refuses the injector's leaf: its request to an inspected host fails, closed, and goes nowhere. The
cell keeps the read-only package mirrors and CDNs on the build's passthrough list, so apt reaches them as before.

## Build

```sh
docker buildx bake runtime-builder                # both platforms, no push
```

The release workflow (`.github/workflows/runtime-cell-release.yml`, job `builder`) builds it from scratch with the
BuildKit it pins, timestamps from BuildKit's release commit (`SOURCE_DATE_EPOCH=1791400699`), no attestation inside
the index, pushes it to GHCR (`ghcr.io/kodustech/kodus-runtime-builder`) and ECR, signs it with cosign and attests
its provenance next to it. The build is reproducible: the cell pins its digest (`cmd/cell/config.go`,
`defaultBuilderImage`), and both the release and the pull-request check (`runtime-cell.yml`, job `builder-image`)
fail when the digest they build is not that one. Revision 2 gave the same index twice on an amd64 host
(`sha256:07f92635…`); that host rebuilt revision 1 as `sha256:e704b2d1…`, not the `f4c8f1e1…` the dev VM gave, so
the pull-request job's first run on a GitHub runner is what confirms the pin.

A cell knows its builder honours `execCABundle` by the pinned digest, under any name (a local registry of the same
digest): only then does it mount the bundle and sign the builder as an inspect source. A local build of a new patch
runs with `-gvisor-builder-trust`.

## Rules

- **Rebase on every BuildKit bump.** When the cell moves to a new BuildKit release: set `BUILDKIT_VERSION` and
  `BUILDKIT_COMMIT` (the commit the tag points at) and the rootless base `moby/buildkit:<v>-rootless@sha256:...`
  (index digest) in the Dockerfile, the Go image to the release's `GO_VERSION`/`ALPINE_VERSION`, the BuildKit pinned
  in both workflows, `SOURCE_DATE_EPOCH` to the new commit's time, reset `KODUS_REVISION` to 1, and refresh both
  patches against the new `util/overlay/overlay_linux.go`, `executor/runcexecutor/executor.go`, `worker/runc/runc.go`
  and `cmd/buildkitd` (`git apply --check` fails the build when one no longer applies). Then build, put the digest it
  gives in `defaultBuilderImage`, and check under runsc: an export's `build.builder_log` must report
  `overlayDifferFallbacks=0`, and `test/gvisoregress` `TestATrustedBuildIsInspectedAndGetsItsSecretsAsPlaceholders`
  must pass with `KODY_E2E_TRUSTED_BUILDER` set to the new image.
- **A patch change bumps `KODUS_REVISION`** and the pinned digest.
- **Drop a patch once upstream ships it.** When both are upstream the image is the upstream one: point
  `defaultBuilderImage` at `moby/buildkit:<v>-rootless@sha256:...` and delete this directory and the `builder` job.

## Upstream status

Neither is reported upstream yet. The overlay fix's pull request text is written (2026-11-12) and waits for approval to
open against moby/buildkit; `exec-ca-bundle.patch` (2026-11-13) has none. Until they are merged and released, every
BuildKit bump goes through the rule above.

## Licenses

BuildKit (moby/buildkit) is Apache-2.0, as is the upstream image this one extends; both patches are under the same
license.
