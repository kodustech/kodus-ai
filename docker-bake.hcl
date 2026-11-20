variable "DOCKERFILE" {
  default = "docker/Dockerfile"
}

variable "RELEASE_VERSION" {
  default = "local"
}

variable "API_CLOUD_MODE" {
  default = "true"
}

variable "CACHE_SCOPE" {
  default = "kodus-ai-arm64"
}

# Build-cache backend. Defaults to GitHub Actions cache (`type=gha`) so
# local builds, `docker compose build`, and the web workflow are
# unchanged. CI jobs that want a durable cache set CACHE_TYPE=registry +
# CACHE_REF=<registry>/<repo>:<tag> to push/pull the cache to a registry
# image instead — registry cache has no 10GB GHA eviction ceiling, so
# cold runners and fresh droplets pull warm layers instead of rebuilding
# the deps/prod-deps stages from scratch.
variable "CACHE_TYPE" {
  default = "gha"
}

variable "CACHE_REF" {
  default = ""
}

variable "API_TAGS" {
  default = "kodus-ai-api:local"
}

variable "WEBHOOKS_TAGS" {
  default = "kodus-ai-webhook:local"
}

variable "WORKER_TAGS" {
  default = "kodus-ai-worker:local"
}

variable "WEB_TAGS" {
  default = "kodus-ai-web:local"
}

variable "MCP_MANAGER_TAGS" {
  default = "kodus-mcp-manager:local"
}

variable "RUNTIME_HUB_TAGS" {
  default = "kodus-runtime-hub:local"
}

variable "RUNTIME_WORKER_TAGS" {
  default = "kodus-runtime-worker:local"
}

variable "RUNTIME_FLEET_TAGS" {
  default = "kodus-runtime-fleet:local"
}

variable "RUNTIME_CELL_TAGS" {
  default = "kodus-runtime-cell:local"
}

variable "RUNTIME_BUILDER_TAGS" {
  default = "kodus-runtime-builder:local"
}

variable "RUNTIME_SANDBOX_TAGS" {
  default = "kodus-runtime-sandbox:local"
}

variable "RUNTIME_MICROVM_ENVIRONMENT_TAGS" {
  default = "kodus-runtime-microvm-environment:local"
}

variable "RUNTIME_MICROVM_KIT_TAGS" {
  default = "kodus-runtime-microvm-kit:local"
}

variable "RUNTIME_MICROVM_PLATFORMS" {
  default = "linux/amd64"
}

variable "RABBITMQ_TAGS" {
  default = "kodus-rabbitmq:local"
}

target "base" {
  context = "."
  dockerfile = "${DOCKERFILE}"
  args = {
    RELEASE_VERSION = "${RELEASE_VERSION}"
    API_CLOUD_MODE = "${API_CLOUD_MODE}"
  }
  # github_token feeds @vscode/ripgrep's postinstall (via @morphllm/
  # morphsdk): it downloads a prebuilt binary from the GitHub releases
  # API, which 403s anonymous calls from shared CI runner IPs (killed
  # the 2026-06-05 release build). Sourced from the GITHUB_TOKEN env at
  # bake time; absent env → empty secret → install runs unauthenticated
  # exactly as before (local builds unaffected).
  secret = ["id=github_token,env=GITHUB_TOKEN"]
  # `image-manifest=true,oci-mediatypes=true` keeps the registry cache a
  # single OCI image (required by ECR, harmless on GHCR). `ignore-error=true`
  # makes a cache-export failure non-fatal — a release must never fail just
  # because the cache push hiccuped.
  cache-from = CACHE_TYPE == "registry" ? ["type=registry,ref=${CACHE_REF}"] : ["type=gha,scope=${CACHE_SCOPE}"]
  cache-to = CACHE_TYPE == "registry" ? ["type=registry,ref=${CACHE_REF},mode=max,image-manifest=true,oci-mediatypes=true,ignore-error=true"] : ["type=gha,scope=${CACHE_SCOPE},mode=max"]
}

target "api" {
  inherits = ["base"]
  target = "api"
  tags = split(",", API_TAGS)
}

target "webhooks" {
  inherits = ["base"]
  target = "webhooks"
  tags = split(",", WEBHOOKS_TAGS)
}

target "worker" {
  inherits = ["base"]
  target = "worker"
  tags = split(",", WORKER_TAGS)
}

target "mcp-manager" {
  inherits = ["base"]
  target = "mcp-manager"
  tags = split(",", MCP_MANAGER_TAGS)
}

target "web" {
  # Unified Dockerfile for cloud and self-hosted — env values come from
  # ConfigProvider/useConfig() at runtime now (see
  # web-runtime-config-migration plan).
  context = "."
  dockerfile = "./docker/Dockerfile.web"
  args = {
    RELEASE_VERSION = "${RELEASE_VERSION}"
  }
  tags = split(",", WEB_TAGS)
  cache-from = ["type=gha,scope=${CACHE_SCOPE}"]
  cache-to = ["type=gha,scope=${CACHE_SCOPE},mode=max"]
}

target "rabbitmq" {
  # Custom RabbitMQ image bundling the rabbitmq_delayed_message_exchange
  # plugin that Kodus needs for workflow delayed retries. Published by
  # .github/workflows/rabbitmq-build-push.yml on its own cadence
  # (changes to docker/rabbitMQ/** or manual dispatch) — this image
  # tracks the RabbitMQ + plugin version, not the Kodus release
  # version, so it's intentionally NOT in the default group below.
  context = "./docker/rabbitMQ"
  dockerfile = "Dockerfile"
  tags = split(",", RABBITMQ_TAGS)
  cache-from = ["type=gha,scope=${CACHE_SCOPE}-rabbitmq"]
  cache-to = ["type=gha,scope=${CACHE_SCOPE}-rabbitmq,mode=max"]
}

# Kody Runtime: the control plane from the product image, the cell from Go.
# Not in the default group: the product release does not publish them until
# the Runtime ships.
target "runtime-hub" {
  inherits = ["base"]
  target = "runtime-hub"
  tags = split(",", RUNTIME_HUB_TAGS)
}

target "runtime-worker" {
  inherits = ["base"]
  target = "runtime-worker"
  tags = split(",", RUNTIME_WORKER_TAGS)
}

target "runtime-fleet" {
  inherits = ["base"]
  target = "runtime-fleet"
  tags = split(",", RUNTIME_FLEET_TAGS)
}

target "runtime-cell" {
  context = "./apps/runtime-cell"
  # The cell's own Dockerfile: distroless, nonroot, version stamped through -ldflags (apps/runtime-cell/README.md).
  dockerfile = "Dockerfile"
  args = {
    RELEASE_VERSION = "${RELEASE_VERSION}"
  }
  tags = split(",", RUNTIME_CELL_TAGS)
  cache-from = ["type=gha,scope=${CACHE_SCOPE}-runtime-cell"]
  cache-to = ["type=gha,scope=${CACHE_SCOPE}-runtime-cell,mode=max"]
}

# The cell's image builder: upstream rootless BuildKit with the overlay differ
# fixed for gVisor (apps/runtime-cell/builder-image/README.md). No cache: its
# digest is pinned in the cell (cmd/cell/config.go), so it is built from
# scratch, both platforms, with timestamps from SOURCE_DATE_EPOCH.
target "runtime-builder" {
  context = "./apps/runtime-cell/builder-image"
  dockerfile = "Dockerfile"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = split(",", RUNTIME_BUILDER_TAGS)
  no-cache = true
  attest = ["type=provenance,disabled=true", "type=sbom,disabled=true"]
  output = ["type=image,rewrite-timestamp=true"]
}

# The code sandbox's tool image with the guest agent (apps/runtime-cell/sandbox-image,
# docs/runtime/sandbox.md): the cell's -gvisor-sandbox-image. Built from the cell's
# Go module (the guest agent) and pinned tools, both platforms.
target "runtime-sandbox" {
  context = "./apps/runtime-cell"
  dockerfile = "sandbox-image/Dockerfile"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = split(",", RUNTIME_SANDBOX_TAGS)
  cache-from = ["type=gha,scope=${CACHE_SCOPE}-runtime-sandbox"]
  cache-to = ["type=gha,scope=${CACHE_SCOPE}-runtime-sandbox,mode=max"]
}

# The sandbox base of the microVM kit: the same tool image, for the kit's
# platforms only, so building the x86_64 kit never builds the arm64 sandbox
# (which needs emulation on an x86_64 host). Untagged: the kit takes it as a
# named context.
target "runtime-microvm-sandbox" {
  context = "./apps/runtime-cell"
  dockerfile = "sandbox-image/Dockerfile"
  platforms = split(",", RUNTIME_MICROVM_PLATFORMS)
}

# The environment microVM's base (apps/runtime-cell/microvm-kit/environment.Dockerfile):
# Docker, Compose, buildx and the cell builder's buildkitd on Ubuntu, turned
# into the kit's rootfs/environment.ext4.
target "runtime-microvm-environment" {
  context = "./apps/runtime-cell/microvm-kit"
  dockerfile = "environment.Dockerfile"
  contexts = {
    builder = "target:runtime-microvm-builder"
  }
  platforms = split(",", RUNTIME_MICROVM_PLATFORMS)
  tags = split(",", RUNTIME_MICROVM_ENVIRONMENT_TAGS)
}

# The cell builder (runtime-builder) for the kit's platforms only, as the
# environment base's named context.
target "runtime-microvm-builder" {
  inherits = ["runtime-builder"]
  platforms = split(",", RUNTIME_MICROVM_PLATFORMS)
  tags = []
  output = []
}

# The microVM kit (apps/runtime-cell/microvm-kit/README.md): firecracker and the
# jailer, the guest kernel and the two base root file systems, with a manifest
# the cell verifies by digest. x86_64 by default (RUNTIME_MICROVM_PLATFORMS):
# KVM on arm64 needs bare metal.
target "runtime-microvm-kit" {
  context = "./apps/runtime-cell"
  dockerfile = "microvm-kit/Dockerfile"
  contexts = {
    sandbox     = "target:runtime-microvm-sandbox"
    environment = "target:runtime-microvm-environment"
  }
  platforms = split(",", RUNTIME_MICROVM_PLATFORMS)
  tags = split(",", RUNTIME_MICROVM_KIT_TAGS)
  attest = ["type=provenance,disabled=true", "type=sbom,disabled=true"]
  output = ["type=image,rewrite-timestamp=true"]
}

group "runtime" {
  targets = ["runtime-hub", "runtime-worker", "runtime-fleet", "runtime-cell", "runtime-builder", "runtime-sandbox"]
}

group "default" {
  targets = ["api", "webhooks", "worker", "web", "mcp-manager"]
}
