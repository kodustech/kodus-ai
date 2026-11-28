# Run the Runtime dev stack on a VM with boat hosts

One command starts the whole dev stack on your own VM (Docker, Linux) and points its Runs at boat hosts. It replaces the hand-made `~/fleet` files.

## You need

- A VM with Docker and this repo checked out, reachable on a public IP or DNS name (ports 3000, 3001, 3332 for the UI, API and webhooks).
- The boat API key, in 1Password (pass `--boat-key-op op://<vault>/<item>/<field>`, which uses `op read`) or in `BOAT_API_KEY`. Never read it with `op document get` (it writes the content to stderr, so it lands in your terminal and logs) and never `cat` `~/fleet/boat.env`. The script writes the key only to that mode-600 file.
- A working LLM for the Runtime planner (see "The LLM").
- The org uuid your Runs belong to (optional: with one org in the dev DB the script picks it).

## Run it

```
scripts/runtime/dev-boat-up.sh --public-host <ip-or-dns> [--org <uuid>[,<uuid>]] \
  [--boat-key-op op://<vault>/<item>/<field>] [--image-store https://<registry>] [--dry-run]
```

`--dry-run` shows the plan: it renders the files to a temp dir and prints every step, touching nothing and reading no key.

It does, in order:

1. Writes `~/fleet/boat.env` (mode 600, `RUNTIME_BOAT_API_KEY`). The key is never printed.
2. Runs `scripts/runtime/dev-ca.sh` when `.runtime-certs/` is missing or was made for another host (the hub certificate carries the public host).
3. Renders `~/fleet/compose.fleet.yml` and `~/fleet/compose.web-origin.yml` (public URLs, `API_CLOUD_MODE=false`, `RUNTIME_DEV_ALLOW_PAT_DOWNLOAD=true`, the GitHub webhook URL) and `.runtime-certs/pools/boat-dev.yaml` from `scripts/runtime/dev-boat/*.tmpl`.
4. Checks the LLM settings (variable names only, no values are read or printed) and stops with a message when they are missing.
5. Starts the stack with the `runtime` and `runtime-fleet` profiles, then restarts `kodus_runtime_hub`, `kodus_runtime_worker` and `kodus_runtime_fleet`. They run ts-node from the mounted code and their compose definition does not change, so `up -d` alone leaves an old process running (an old worker once dead-lettered a setup as `invalid_command`). It waits for `runtime-hub listening` after the restart and sets the orgs' release track to `alpha`.
6. Runs `runtime-fleet apply` and checks the pool row (database `kodus_runtime`, schema `runtime`) has the cell base. Editing the pool file alone applies nothing.

Re-running is safe: it rewrites the files and applies the pool again.

## The cell base

`BOAT_CELL_BASE` is one variable at the top of the script. Bump it when a new cell image is published, then re-run.

## The LLM

The Runtime planner calls the product LLM gateway on `kodus-api`, which uses the org's BYOK model or, without one, the env model. With neither, the first Run dies with `AUTH_INVALID`. The script checks that `.env` / `.env.local` set `API_LLM_PROVIDER` and its key (`API_LLM_API_KEY`, or the provider's own key variable; `API_LLM_BASE_URL` for `*_compatible` providers). See `.env.example`.

- Dev LLM keys can be out of credit. The Runtime needs a provider that works, for example the team's LiteLLM gateway set up as the org's BYOK model in the UI.
- If the org has a working BYOK model and the env has none, pass `--skip-llm-check`.

## Manual steps

- Port 3410 (the runtime hub) must be reachable from the boat hosts. The script never edits cloud firewalls. On runo VMs the shared security group cannot be edited: create a dedicated security group that opens only inbound TCP 3410 (to the boat hosts' addresses, or the range your team uses) and attach it to the VM as an extra group.
- Set the environment's machine size in the UI. `medium` now places the base and PR sides on separate hosts automatically; there is no need to shrink the recipe to 7 GB per side.
- Comment `@kody runtime` on a PR of a connected repo.
- With `--image-store`, the registry itself (certificate, `docs/runtime/shared-image-store.md`) is yours; the script only writes the hub's signing key and the pool block.

## Check it

```
docker logs kodus_runtime_hub 2>&1 | grep 'runtime-hub listening'
# Runtime tables are in the kodus_runtime database, not $POSTGRES_DB.
docker exec db_postgres sh -c 'psql -U "$POSTGRES_USER" -d kodus_runtime -c "select pool_id, provider, spec::text like '"'"'%<base>%'"'"' as has_base from runtime.runtime_host_pools"'
```
