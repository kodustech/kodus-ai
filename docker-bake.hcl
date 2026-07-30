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

group "default" {
  targets = ["api", "webhooks", "worker", "web", "mcp-manager"]
}
