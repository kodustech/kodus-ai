# Docs

Mintlify-powered public documentation site for Kodus. Lives at `docs/`
inside the kodus-ai monorepo (was previously a separate repo). Site is
configured via `docs.json` and content is written in `.mdx` files.

## Development

The `mintlify` CLI is installed globally on most dev machines. From the
repo root:

```bash
pnpm run docs:dev          # starts the local preview at localhost:3001
pnpm run docs:install      # re-installs Mintlify deps if `dev` fails
pnpm run docs:check        # validates broken links across the site
```

If you don't have the CLI yet:

```bash
npm i -g mintlify
```

You can also run Mintlify directly inside the `docs/` folder:

```bash
cd docs
mintlify dev
```

## Publishing Changes

Push to the default branch. The GitHub App/integration auto-deploys from
the default branch.

## Structure

- `docs.json` — site configuration and navigation
- `how_to_use/` — product usage guides
- `how_to_deploy/` — deployment guides (multi-language)
- `cookbook/` — example setups and recipes
- `knowledge_base/` — concept docs / FAQ
- `_snippets/` — reusable MDX fragments imported via `<Snippet>` component
- `_snippets/env-vars-generated.mdx` — **auto-generated** from
  `kodus-ai/.env.schema`. Don't edit by hand. Run `pnpm run env:apply` to
  regenerate after schema changes.

## Internal engineering docs

Engineering plans, runbooks, and dev-only guides live in `docs-internal/`
(separate from this site). Those don't ship to the public docs.

## Troubleshooting

- `mintlify dev` not running → `pnpm run docs:install` to re-install deps.
- 404 on load → make sure `docs.json` is in the directory mintlify is
  running from (the `pnpm run docs:dev` script handles this for you).
