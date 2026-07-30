# 1Password reference paths (internal team)

This file is the source of truth for **internal Kodus engineers**. External contributors can ignore it — the `setup` flow works fine with plain values.

## Why use 1Password refs

When you set a field's value to `op://Vault/Item/field` in `~/.kodus-dev/config`, the scripts resolve it at runtime via the `op` CLI. Benefits:

- Single source of truth — rotate a secret in 1Password, every dev's next run picks up the new value
- No secrets in plaintext files on your laptop
- Audit trail in 1Password for who accessed what
- New team members get access just by being added to the vault

## Prerequisites

1. Install the CLI: `brew install --cask 1password-cli`
2. Authenticate: enable the 1Password app integration (Settings → Developer → CLI), or run `eval $(op signin)`
3. Verify: `op read "op://Engineering/kodus-self-hosted-dev/do-token"` should print a token

## Standard paths

> All in vault **Engineering**, item **kodus-self-hosted-dev**.

| Env | Reference path | Notes |
|---|---|---|
| `DIGITALOCEAN_TOKEN` | `op://Engineering/kodus-self-hosted-dev/do-token` | Required |
| `SH_LICENSE_KEY` | `op://Engineering/kodus-self-hosted-dev/license-paid` | Optional |
| `SH_LICENSE_KEY_PATH` | path to a `seats=1` JWT on disk (default `~/.kodus-dev/license-seats1.jwt`) | Optional; needed only by the `per-seat-license-toggle` matrix scenario |
| `GH_DEV_TOKEN` | `op://Engineering/kodus-self-hosted-dev/gh-bot-token` | Optional |
| `API_OPEN_AI_API_KEY` | `op://Engineering/kodus-self-hosted-dev/openai-key` | **Required.** Stores the Moonshot API key (team default uses Kimi K2.6 — see below). For native OpenAI, replace with a `sk-...` from platform.openai.com. |

### LLM provider config (Kimi K2.6 default — not secret)

These are not in 1Password — they're plain values with team defaults set in `setup.sh`:

| Env | Default value | Override if |
|---|---|---|
| `API_OPENAI_FORCE_BASE_URL` | `https://api.moonshot.ai/v1` | Using native OpenAI, set empty or `https://api.openai.com/v1` |
| `API_LLM_PROVIDER_MODEL` | `kimi-k2.6` | Using native OpenAI, set to `gpt-4o` (or `auto` to let Kodus router pick) |

## How to use

1. Run `pnpm run selfhosted:setup`
2. For each prompt, paste the reference from the table above
3. The setup will validate each ref against 1Password and warn if it doesn't resolve
4. After setup, your `~/.kodus-dev/config` looks like:

   ```bash
   DIGITALOCEAN_TOKEN=op://Engineering/kodus-self-hosted-dev/do-token
   SH_LICENSE_KEY=op://Engineering/kodus-self-hosted-dev/license-paid
   GH_DEV_TOKEN=op://Engineering/kodus-self-hosted-dev/gh-bot-token
   API_OPEN_AI_API_KEY=op://Engineering/kodus-self-hosted-dev/openai-key
   KODUS_INSTALLER_PATH=/Users/you/dev/kodus-installer
   ```

5. `pnpm run selfhosted:provision`, `deploy`, `destroy` etc. resolve the refs on each invocation

## Adding a new secret to the team vault

1. Open the **kodus-self-hosted-dev** item in the **Engineering** vault
2. Add a new field — type "Password" or "Text"
3. Pick a slug (lowercase-hyphenated) for the field name
4. Update this file with the new path
5. Notify the team in #engineering (so anyone running the scripts updates their setup)

## Mixing plain + refs

You can mix freely. E.g., test a custom DO token locally while keeping the team's license key:

```bash
# ~/.kodus-dev/config
DIGITALOCEAN_TOKEN=dop_v1_my_personal_test_token
SH_LICENSE_KEY=op://Engineering/kodus-self-hosted-dev/license-paid
API_OPEN_AI_API_KEY=op://Engineering/kodus-self-hosted-dev/openai-key
```

## When op resolution fails

```
ERROR: DIGITALOCEAN_TOKEN is a 1Password reference (op://Engineering/kodus-self-hosted-dev/do-token),
       but failed to resolve:
       [1Password CLI] Authentication required.
       Make sure 'op signin' is current (or 1Password app integration is enabled)
       and the reference path is correct.
```

Fix in order of likelihood:

1. **`op signin`** — your session expired (defaults to 30 min)
2. **Enable app integration** — Settings → Developer → "Integrate with 1Password CLI" (no need to sign in per shell)
3. **Check the path** — `op read "op://Engineering/kodus-self-hosted-dev/do-token"` directly, fix if needed
4. **Check vault access** — `op vault list` to confirm you can see Engineering vault
