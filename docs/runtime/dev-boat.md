# Run the Runtime dev stack on a VM with boat hosts

One command starts the whole dev stack on your own VM (Docker, Linux) and points its Runs at boat hosts. It replaces the hand-made `~/fleet` files.

## You need

- A VM with Docker and this repo checked out, reachable on a public IP or DNS name (ports 3000, 3001, 3332 for the UI, API and webhooks).
- The boat API key, in 1Password (`op read "<ref>"`) or in `BOAT_API_KEY`.
- The org uuid your Runs belong to (optional: with one org in the dev DB the script picks it).

## Run it

```
scripts/runtime/dev-boat-up.sh --public-host <ip-or-dns> [--org <uuid>[,<uuid>]] \
  [--boat-key-op op://<vault>/<item>/<field>] [--image-store https://<registry>] [--dry-run]
```

`--dry-run` renders the files to a temp dir and prints the steps, touching nothing and reading no key.

It does, in order:

1. Writes `~/fleet/boat.env` (mode 600, `RUNTIME_BOAT_API_KEY`). The key is never printed.
2. Runs `scripts/runtime/dev-ca.sh` when `.runtime-certs/` is missing or was made for another host (the hub certificate carries the public host).
3. Renders `~/fleet/compose.fleet.yml` and `~/fleet/compose.web-origin.yml` (public URLs, `API_CLOUD_MODE=false`, `RUNTIME_DEV_ALLOW_PAT_DOWNLOAD=true`, the GitHub webhook URL) and `.runtime-certs/pools/boat-dev.yaml` from `scripts/runtime/dev-boat/*.tmpl`.
4. Starts the stack with the `runtime` and `runtime-fleet` profiles, waits for `runtime-hub listening`, sets the orgs' release track to `alpha`.
5. Runs `runtime-fleet apply` and checks the pool row has the cell base. Editing the pool file alone applies nothing.

Re-running is safe: it rewrites the files and applies the pool again.

## The cell base

`BOAT_CELL_BASE` is one variable at the top of the script. Bump it when a new cell image is published, then re-run.

## Manual steps

- Open inbound TCP 3410 on the VM's firewall or security group for the boat hosts. The script never edits cloud firewalls.
- Set the environment's machine size in the UI (medium for heavy apps).
- Comment `@kody runtime` on a PR of a connected repo.
- With `--image-store`, the registry itself (certificate, `docs/runtime/shared-image-store.md`) is yours; the script only writes the hub's signing key and the pool block.

## Check it

```
docker logs kodus_runtime_hub 2>&1 | grep 'runtime-hub listening'
docker exec db_postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select pool_id, provider, spec::text like '"'"'%<base>%'"'"' as has_base from runtime.runtime_host_pools"'
```
