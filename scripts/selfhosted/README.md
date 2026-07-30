# Self-hosted dev VM

Provisions a real self-hosted Kodus stack on a cloud VM, leaves it alive for you (and the team) to test against, destroys it when you say so. Unrelated to the automated E2E suite in `tests/e2e/` — this is for manual work.

## Mental model

Three commands, in this order:

```text
provision   ─►   deploy   ─►   destroy
   (1x)         (N times)        (1x)
```

- **`provision`**: creates a fresh cloud VM with the latest published image. Slow (~10 min). Run once per session.
- **`deploy`**: builds your local code and ships it to the alive VM. Fast (~3 min). Run after every code change you want to validate.
- **`destroy`**: kills the VM, removes resources. Run when done.

## Quick start — test your local branch

```bash
# 1) Bootstrap (once per machine — saves to ~/.kodus-dev/config)
pnpm run selfhosted:setup

# 2) Provision a droplet (~10 min, runs published :latest image)
pnpm run selfhosted:provision

# 3) Deploy YOUR branch onto the droplet (~3 min)
pnpm run selfhosted:deploy

# 4) Iterate — edit code, deploy again as needed
pnpm run selfhosted:deploy

# 5) Destroy when done
pnpm run selfhosted:destroy
```

After step 2, `provision` will print a `⚠️` warning reminding you that the running image is the published one, not your code. After step 3, you're running your branch.

## Quick start — test a published version (no local code)

For repro-ing a customer bug, validating an RC, or running a demo:

```bash
pnpm run selfhosted:setup
IMAGE_TAG=selfhosted-2.1.11 pnpm run selfhosted:provision
# poke the dashboard manually
pnpm run selfhosted:destroy
```

Skip the `deploy` step entirely — you want exactly the published image.

## Inspecting and debugging

```bash
pnpm run selfhosted:status                       # health + URLs of all instances
pnpm run selfhosted:ssh                          # open shell on the VM
pnpm run selfhosted:ssh -- 'docker compose ps'   # run a one-off remote command
pnpm run selfhosted:logs                         # tail all service logs
pnpm run selfhosted:logs -- api worker           # tail specific services
```

## Where secrets live

In priority order (higher wins):

1. **Inline-exported env** — `IMAGE_TAG=foo pnpm run selfhosted:provision`
2. **`scripts/selfhosted/.env`** — per-repo override (gitignored)
3. **`~/.kodus-dev/config`** — global per-machine (managed by `pnpm run selfhosted:setup`)

`~/.kodus-dev/config` is the recommended path: set it up once and forget. Works across every clone of the repo, survives project reinstalls.

```bash
pnpm run selfhosted:setup         # interactive (auto-runs on first provision)
pnpm run selfhosted:setup --show  # show current config (masked)
pnpm run selfhosted:setup --path  # print config file path
```

If `direnv` is installed, the setup script offers to create a `.envrc` in the repo that auto-loads the config when you `cd` into the directory. Without direnv, the scripts read `~/.kodus-dev/config` directly anyway.

### 1Password CLI (internal team)

Each value in `~/.kodus-dev/config` can be either a plain value or a 1Password reference (`op://Vault/Item/field`). Internal Kodus engineers use refs so secrets stay in the team vault — rotation is automatic. External contributors just paste plain values.

```bash
# Example config mixing both:
DIGITALOCEAN_TOKEN=op://Engineering/kodus-dev/do-token   # team ref
SH_LICENSE_KEY=lic-paid-plain-value                      # plain
API_OPEN_AI_API_KEY=op://Engineering/kodus-dev/openai-key # team ref
```

See [`op-references.md`](./op-references.md) for the team's standard paths and setup. The `op` CLI is auto-detected; if not installed, plain-value prompts are used.

## Multi-instance

You and a teammate can have stacks alive at the same time:

```bash
pnpm run selfhosted:provision --name junior
pnpm run selfhosted:provision --name wellington
pnpm run selfhosted:status                       # lists both
pnpm run selfhosted:deploy --name junior         # only deploys to junior's VM
pnpm run selfhosted:destroy --name junior
pnpm run selfhosted:destroy --name wellington
```

Each `--name` becomes a suffix on the droplet (`kodus-selfhosted-junior`) and the local state file (`.kodus-dev/selfhosted-vm-junior.json`). The Docker image tag pushed by `deploy` is also per-name (`dev-junior`), so deploys don't collide.

## How `deploy` works

```text
1. docker buildx bake -f docker-bake.hcl --push   # builds locally, pushes layers diff to YOUR GHCR namespace
2. write docker-compose.override.yml on droplet   # pins all 5 services to your dev tag
3. ssh droplet: docker compose pull + up -d       # pulls the new images, restarts
4. healthcheck web/api/webhooks                   # waits until responsive
```

Iteration cost:

| | Time | Why |
|---|---|---|
| First deploy | 5-8 min | Cold buildx, all layers push fresh |
| Subsequent deploys (small diff) | 1-2 min | Only changed layers push |
| Whole stack rebuild after changing shared code | 2-4 min | Several services rebuild but cache helps |
| `--no-build` (teammate already pushed) | 30-60s | Skip build, just pull + restart |

Variants:

```bash
pnpm run selfhosted:deploy -- api worker    # only rebuild these (faster)
pnpm run selfhosted:deploy --no-build       # skip build, just pull + restart
```

Requirements:
- `gh auth login` completed (we read your GHCR token from `gh` CLI)
- Docker with buildx

Images are pushed to `ghcr.io/<your-gh-user>/kodus-ai-{api,worker,webhook,web,mcp-manager}:dev-<instance-name>` — each dev has their own namespace, no conflict with org-published images.

## Configuration

Recommended: run `pnpm run selfhosted:setup`, which prompts for the fields below interactively. To set values manually, use any of the 3 sources in [Where secrets live](#where-secrets-live).

### Required

| Env | How to obtain |
|---|---|
| `DIGITALOCEAN_TOKEN` | [cloud.digitalocean.com/account/api](https://cloud.digitalocean.com/account/api) — scopes `droplet:create/read/delete` + `ssh_key:create/read/delete` |

### Optional

| Env | Default | Purpose |
|---|---|---|
| `KODUS_INSTALLER_PATH` | `../kodus-installer` | Path to the local installer checkout |
| `TEST_VM_PROVIDER` | `digitalocean` | Set to `hetzner` to use Hetzner Cloud (requires `HCLOUD_TOKEN`) |
| `IMAGE_TAG` | `latest` | GHCR image tag for `provision`. Useful to test a specific RC (`selfhosted-X.Y.Z-rc.N`) |
| `SH_LICENSE_KEY` | (none) | If set, stack boots with the license injected (paid features unlocked) |
| `GH_DEV_TOKEN` | (none) | If set, auto-configures the GitHub integration after signup — dashboard ready to use |
| `API_OPEN_AI_API_KEY` | (none) | OpenAI API key. **Required for Kodus to review PRs.** Without it, the dashboard shows a "No LLM provider configured" banner. Get one at https://platform.openai.com/api-keys. |
| `API_OPENAI_FORCE_BASE_URL` | (none) | Optional. Override `api.openai.com` — set to e.g. `https://your-proxy/v1` for Azure OpenAI, OpenRouter, or local LLM proxies. |
| `DO_REGION` | `nyc3` | DigitalOcean region |
| `DO_SIZE` | `s-2vcpu-4gb` | Droplet size (~$24/mo if left running) |

## Local state

`provision.sh` saves each instance's metadata to `.kodus-dev/selfhosted-vm-{name}.json`:

```json
{
  "name": "default",
  "provider": "digitalocean",
  "server_id": "487234",
  "server_ip": "164.92.x.x",
  "ssh_key_id": "998877",
  "ssh_key_path": ".kodus-dev/ssh-keys/default",
  "tunnel_url": "https://chunky-llama.trycloudflare.com",
  "dashboard_url": "http://164.92.x.x:3000",
  "api_url": "http://164.92.x.x:3001",
  "image_tag": "latest",
  "tenant": {
    "email": "dev-default-1715812345@kodus.local",
    "password": "k8j3xX2qaPlmnQAa1!"
  },
  "gh_integration_configured": false,
  "created_at": "2026-05-15T18:32:01Z"
}
```

`.kodus-dev/` is in `.gitignore`. Passwords and tokens stay on your machine only.

## Cost

- DO `s-2vcpu-4gb`: ~$0.036/h ≈ **$0.86/day** ≈ $26/month if left running
- Hetzner CX22: ~$0.006/h ≈ **$0.14/day** (cheaper for sustained dev use)

Don't forget `pnpm run selfhosted:destroy` when you're done.

## Troubleshooting

### "Instance 'default' already exists"

You tried to `provision` but one is already alive. Options:
- Use a different name: `pnpm run selfhosted:provision --name new`
- Destroy the current one: `pnpm run selfhosted:destroy`

### Stack came up but dashboard doesn't load

```bash
pnpm run selfhosted:ssh -- 'docker compose ps'         # which containers are healthy
pnpm run selfhosted:logs -- web api                    # check for errors
```

Common causes:
- Memory pressure on `s-2vcpu-4gb` → use `DO_SIZE=s-4vcpu-8gb`
- `WEB_HOSTNAME_API` wrong (must be `localhost`, the sentinel that makes the web resolve the API via `GLOBAL_API_CONTAINER_NAME`, i.e. the `kodus_api` container)
- Container crash-looping due to a missing env var → read the logs

### Tunnel URL changed

Cloudflare quick tunnel generates a random URL. If `cloudflared` restarts (rare), the URL changes. To fetch the current one:

```bash
pnpm run selfhosted:ssh -- 'grep -oE "https://[a-zA-Z0-9-]+\.trycloudflare\.com" /var/log/cloudflared.log | head -1'
```

For a stable URL you'd need Cloudflare Named Tunnel — outside the scope of this helper; configure manually if needed.

### `deploy` says "No instance named 'default'"

`deploy` requires a `provision` to have run first. Run `pnpm run selfhosted:provision` to create the droplet, then `pnpm run selfhosted:deploy` to ship your code.

### I want to run an E2E matrix scenario against this instance

Doesn't work out-of-the-box because the E2E matrix uses its own provisioning. But you can do it manually:

```bash
cd tests/e2e
SERVER_IP=$(jq -r .server_ip ../../.kodus-dev/selfhosted-vm-default.json)
TUNNEL=$(jq -r .tunnel_url ../../.kodus-dev/selfhosted-vm-default.json)
EMAIL=$(jq -r .tenant.email ../../.kodus-dev/selfhosted-vm-default.json)
PASS=$(jq -r .tenant.password ../../.kodus-dev/selfhosted-vm-default.json)

TARGET_BASE_URL=http://$SERVER_IP:3001 \
TARGET_WEB_URL=http://$SERVER_IP:3000 \
TARGET_TUNNEL_URL=$TUNNEL \
SH_TENANT_EMAIL=$EMAIL \
SH_TENANT_PASSWORD=$PASS \
GH_TEST_TOKEN=$YOUR_TOKEN GH_TEST_REPO=owner/repo GH_TEST_PR_NUMBER=1 \
npm run scenario -- --scenario code-review-basic --target self-hosted --provider github --license license-paid
```

## How this fits with the rest

| Goal | Use |
|---|---|
| Test my unmerged branch end-to-end as self-hosted | `pnpm run selfhosted:provision` + `pnpm run selfhosted:deploy` (this) |
| Reproduce a customer bug | `IMAGE_TAG=selfhosted-X.Y.Z pnpm run selfhosted:provision`, then poke (no deploy) |
| Demo for internal team or customer | `pnpm run selfhosted:provision`, keep alive as long as you need |
| Automated pre-release QA | `tests/e2e/` + workflows (`e2e-self-hosted-matrix.yml`) |
| Monorepo code development (cloud mode + hot reload) | `pnpm run docker:start` (not this helper) |

## Limitations

- **Cloudflare quick tunnel** is not stable — the hostname changes on restart. Fine for dev, not for production integrations.
- **No state persistence** across destroys — `destroy.sh` wipes everything. For DB snapshots, out of scope (do it manually via SSH with `pg_dump` before destroying).
- **License key** must be supplied via env — no built-in license generator.
- **GitHub auto-config** only wires GitHub. For GitLab/Bitbucket/Azure, configure manually through the dashboard afterward.
