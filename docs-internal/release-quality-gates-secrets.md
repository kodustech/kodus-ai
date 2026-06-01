# Release quality gates — manual setup guide

Everything you need to fill in to close the last gap before the first release that runs the quality matrix against real infrastructure. **Verified against the official provider docs in May 2026.**

> Convention: `Secret` = configured under **Settings → Secrets and variables → Actions → Secrets**. `Variable` = configured under the **Variables** tab next to it. The `production` environment is used for the most sensitive values (license keys, cloud tenants) so they can be gated behind required reviewers.

> Recommended order: do **Block 0** first (5 secrets, ~30 min) — that already runs 1 real cell. Then Blocks 1, 2, 3 in parallel as you create the accounts.

---

## Quick map — where to add

- URL: `https://github.com/kodustech/kodus-ai-quality-gates/settings/secrets/actions`
- **Secrets** tab for sensitive values (tokens, passwords)
- **Variables** tab for non-sensitive values (public URLs)
- The **production** environment is used when a row is marked `[env:production]`

To add a secret:
1. Open the URL above
2. **New repository secret** (or open the `production` env first to create it there)
3. Use the exact name from the **Variable** column
4. Paste the value from the corresponding step

---

## Block 0 — Minimum viable (~30 min, runs 1 real cell)

Do these 5 and tell me. I'll trigger the real workflow and we'll validate `github × self-hosted × license-paid`.

| Variable | Type | How to obtain |
|---|---|---|
| `DIGITALOCEAN_TOKEN` | Secret | [Block 1](#block-1--digitalocean) |
| `GH_TEST_TOKEN` | Secret | [Block 2](#block-2--github-bot) |
| `GH_TEST_REPO` | Secret | [Block 2](#block-2--github-bot) |
| `GH_TEST_PR_NUMBER` | Secret | [Block 2](#block-2--github-bot) |
| `SH_LICENSE_KEY_PAID` | Secret `[env:production]` | [Block 6](#block-6--self-hosted-license-keys) |

For the other providers (GitLab, Bitbucket, Azure DevOps) and cloud QA: blocks 3-5 and 7.

---

## Block 1 — DigitalOcean

Provisions ephemeral droplets for the self-hosted matrix shards.

### How to get the token

1. Log in to **https://cloud.digitalocean.com**
2. Left menu → **API**
3. **Tokens** tab → **Generate New Token**
4. **Token name**: `kodus-e2e-matrix`
5. **Expiration**: 90 days (plan to rotate)
6. **Scopes**: **Custom** with ONLY these:
   - `droplet:create`
   - `droplet:read`
   - `droplet:delete`
   - `ssh_key:create`
   - `ssh_key:read`
   - `ssh_key:delete`
7. **Generate Token** → copy the `dop_v1_...` string

### Where to add

| Variable | Type | Value |
|---|---|---|
| `DIGITALOCEAN_TOKEN` | Secret | the `dop_v1_...` string |

> **Predictable cost**: ~$0.04 per shard (CX22-equivalent, ~25 min). Full P0 self-hosted matrix = 5 shards × $0.04 = **$0.20/release**.

---

## Block 2 — GitHub bot

For the `github × {cloud, self-hosted}` scenario.

### Account + fixture repo

If you already have a GitHub bot for the legacy E2E (`tests/e2e/.env` in kodus-installer), reuse the 3 existing secrets. Otherwise:

1. Create/use a dedicated GitHub test account (e.g. `kodus-qa-bot`)
2. Create/use a small public repo as fixture (e.g. `kodus-qa-bot/qa-fixtures`)
3. Open 1 long-lived PR on the repo (any trivial change, leave it open forever). Record the PR number.

### Token — Fine-grained PAT (recommended)

1. URL: **https://github.com/settings/personal-access-tokens/new**
2. **Token name**: `kodus-e2e-matrix`
3. **Expiration**: 90 days
4. **Resource owner**: the owner of the fixture repo (your bot account or the organization)
5. **Repository access** → **Only select repositories** → select the fixture repo
6. **Repository permissions**:
   - **Contents** → **Read and write** (HTTPS clone, push branches)
   - **Pull requests** → **Read and write** (open, close, comment)
   - **Issues** → **Read and write** (issue comments are how PR comments are posted)
   - **Webhooks** → **Read and write** (matrix creates a webhook per self-hosted run)
   - **Metadata** → **Read-only** (auto-included)
7. **Generate token** → copy the `github_pat_...`

> **Careful with public repos + external owner**: fine-grained PATs cannot write to public repos where the user isn't a member. If the fixture lives in another org/user, either use a classic PAT with the `repo` scope (at `https://github.com/settings/tokens`), or add the bot as a member.

### Where to add

| Variable | Type | Value |
|---|---|---|
| `GH_TEST_TOKEN` | Secret | `github_pat_...` |
| `GH_TEST_REPO` | Secret | `kodus-qa-bot/qa-fixtures` (in `owner/repo` form) |
| `GH_TEST_PR_NUMBER` | Secret | the open PR number (e.g. `1`) |

---

## Block 3 — GitLab bot

For the `gitlab × {cloud, self-hosted}` scenario.

### Account + fixture project

1. Create/use a dedicated account on **https://gitlab.com** (free tier works)
2. Create a public project (e.g. `kodus-qa-bot/qa-fixtures-gl`)
3. Open 1 long-lived MR. Record the **IID** (not the ID — the IID is the number you see in the URL, e.g. `!7`).

### Token — Personal Access Token

1. URL: **https://gitlab.com/-/user_settings/personal_access_tokens**
2. **Add new token** → **Generate token** → **Legacy token** (the new Generate token flow does not support the scopes we need)
3. **Token name**: `kodus-e2e-matrix`
4. **Expiration date**: 365 days (default max)
5. **Scopes**:
   - `api` — covers webhook creation, opening MRs, posting notes, HTTPS cloning
6. **Create personal access token** → copy the `glpat-...`

> Only `api` is needed. `write_repository` is included in `api` for cloning purposes.

### Where to add

| Variable | Type | Value |
|---|---|---|
| `GL_TEST_TOKEN` | Secret | `glpat-...` |
| `GL_TEST_REPO` | Secret | `kodus-qa-bot/qa-fixtures-gl` (full project path) |
| `GL_TEST_MR_IID` | Secret | the open MR IID (e.g. `7`) |

(Optional: `GL_HOST` as a **Variable** if you use a self-hosted GitLab instance for QA. Default is `https://gitlab.com`.)

---

## Block 4 — Bitbucket bot

For the `bitbucket × {cloud, self-hosted}` scenario.

> **Heads up**: Atlassian replaced **App Passwords** with **API Tokens** during 2025. App passwords still work until the official sunset date, but for new accounts use an API token. The code supports both (it's HTTP Basic). The env var is still named `BB_TEST_APP_PASSWORD` for backward compatibility — the name doesn't matter, the value does.

### Account + fixture repo

1. Create/use a dedicated account on **https://bitbucket.org/account/signup/**. The Bitbucket username is distinct from the Atlassian email — you need both.
2. Create a workspace + repo (e.g. workspace `kodus-qa`, repo `qa-fixtures-bb`)
3. Open 1 long-lived PR. Record the PR **ID** (number in the URL, `pull-requests/3` → ID = 3).

### Token — API Token (new flow)

1. URL: **https://id.atlassian.com/manage-profile/security/api-tokens**
2. **Create API token with scopes**
3. **Label**: `kodus-e2e-bitbucket`
4. **App**: **Bitbucket**
5. **Expiration**: 1 year
6. **Scopes** (exactly these):
   - `read:repository:bitbucket` — HTTPS clone
   - `write:pullrequest:bitbucket` — open PRs + post comments
   - `write:webhook:bitbucket` — create webhooks on the repo
7. **Create** → copy the `ATATT3xFfGF0...` token (Atlassian API token format, ~190 chars)

### Username for basic auth

To use the token via HTTP Basic, the username is the **Atlassian account email** (not the Bitbucket username). E.g. `kodus-qa-bot@kodus.io`.

### Where to add

| Variable | Type | Value |
|---|---|---|
| `BB_TEST_USER` | Secret | Atlassian email of the bot account (e.g. `kodus-qa-bot@kodus.io`) |
| `BB_TEST_APP_PASSWORD` | Secret | the API token `ATATT3xFfGF0...` (legacy var name) |
| `BB_TEST_REPO` | Secret | `kodus-qa/qa-fixtures-bb` (in `workspace/repo-slug` form) |
| `BB_TEST_PR_ID` | Secret | numeric PR ID (e.g. `3`) |

> When creating the repo, the **workspace slug** appears in the URL: `bitbucket.org/<workspace-slug>/<repo-slug>`. The slug may differ from the display name.

---

## Block 5 — Azure DevOps bot

For the `azure-devops × {cloud, self-hosted}` scenario — explicitly the most painful provider today.

### Org + project + fixture repo

1. Create/use a dedicated Microsoft account
2. Create an organization on **https://dev.azure.com** (free tier works; no Visual Studio license needed for basic access)
3. **New project** inside the org (private visibility is fine)
4. **Repos** → create/import a fixture repo
5. Open 1 long-lived PR. Record the **Pull Request ID** (number in the URL: `pullrequest/23` → 23).

### Token — Personal Access Token

1. URL: **https://dev.azure.com/{YOUR_ORG}/_usersSettings/tokens**
2. **+ New Token**
3. **Name**: `kodus-e2e-azure`
4. **Organization**: the org created above (not "All accessible organizations")
5. **Expiration (UTC)**: 90 days (or 1 year custom)
6. **Scopes**: **Custom defined**, check:
   - **Code** → **Read & write** (covers `vso.code_write` — opening PRs, reading/writing code, creating code reviews)
   - **Code (Status)** → auto-checked
   - **PR threads** → appears as a sub-option of Code; make sure it's checked (covers `vso.threads_full` — posting comments on PR threads)
   - **Service connections** → Read (sufficient)
   - **Service Hooks** if visible → check it (not always shown — when absent, the webhook is created as a subscription via API anyway)
7. **Create** → copy the PAT (Base64-like string, 84 chars ending in `AZDO`)

> If your org has restrictive PAT policies (admin policy), you may not be able to check all the scopes. In that case ask the admin to add you to the allow list.

### Where to add

| Variable | Type | Value |
|---|---|---|
| `AZ_TEST_TOKEN` | Secret | the PAT (84 chars) |
| `AZ_TEST_ORG` | Secret | org name (e.g. `kodus-qa`) |
| `AZ_TEST_PROJECT` | Secret | project name (e.g. `kodus-fixtures`) |
| `AZ_TEST_REPO` | Secret | repo name (e.g. `qa-fixture-az`) |
| `AZ_TEST_PR_ID` | Secret | numeric PR ID (e.g. `23`) |

---

## Block 6 — Self-hosted license keys

To exercise the difference between `license-paid` and `license-free` behavior on self-hosted.

### How to obtain

Depends on whoever maintains the self-hosted license generator/issuer today. Ask internally:
- The Kodus billing/licensing team
- Or whoever owns `libs/ee/license/`

You need 2 test keys, clearly marked as **non-production**:

1. **Paid license**: a key that unlocks review + paid features on self-hosted
2. **Free license**: a key that blocks paid features (or no key at all, if that's the intended free behavior)

> Important: the **free** key must NOT allow code review. The `license-attribution × self-hosted × license-free` scenario validates exactly that reviews do not happen with this key.

### Where to add

| Variable | Type | Value |
|---|---|---|
| `SH_LICENSE_KEY_PAID` | Secret `[env:production]` | key that unlocks features |
| `SH_LICENSE_KEY_FREE` | Secret `[env:production]` | key that blocks (or empty string if "no key = free") |

---

## Block 7 — Cloud QA tenants

To exercise `free` vs `trial` vs `paid` behavior on cloud. Requires coordination with whoever owns billing/auth on cloud QA.

### What to create

3 tenants on cloud QA (at `app-qa.kodus.io`), each with:

1. **Stable email + password** (no recovery flow — these can live in a secret forever)
2. **Matching plan**: free, trial, or paid
3. **Connected provider**: ideally all 4 (GitHub, GitLab, Bitbucket, Azure DevOps) already configured with the same fixture repo appearing in "available repos" — so the onboarding scenario can find the repo
4. **Trial with extended window** (e.g. 1 year instead of 14 days) so it doesn't expire and break the matrix

### Where to add

| Variable | Type | Value |
|---|---|---|
| `CLOUD_TENANT_FREE_EMAIL` | Secret `[env:production]` | e.g. `tenant-free@kodus.test` |
| `CLOUD_TENANT_FREE_PASSWORD` | Secret `[env:production]` | stable password |
| `CLOUD_TENANT_TRIAL_EMAIL` | Secret `[env:production]` | e.g. `tenant-trial@kodus.test` |
| `CLOUD_TENANT_TRIAL_PASSWORD` | Secret `[env:production]` | stable password |
| `CLOUD_TENANT_PAID_EMAIL` | Secret `[env:production]` | e.g. `tenant-paid@kodus.test` |
| `CLOUD_TENANT_PAID_PASSWORD` | Secret `[env:production]` | stable password |

### Optional variables

If the cloud QA URL is not the default, configure them as **Variables** (not Secrets):

| Variable | Type | Default if absent |
|---|---|---|
| `CLOUD_QA_API_URL` | Variable | `https://api-qa.kodus.io` |
| `CLOUD_QA_WEB_URL` | Variable | `https://app-qa.kodus.io` |

---

## Block 8 — Verify existing infra secrets

Confirm these are already configured (no need to recreate, just verify):

| Variable | Where | Used by |
|---|---|---|
| `RELEASE_BOT_TOKEN` | Repo Secret | Pushing to a protected branch; checking out `kodustech/kodus-installer` in the matrix workflow. Needs `contents:write` scope on both repos. |
| `DISCORD_WEBHOOK_SELFHOSTED` | `production` Secret | Discord notification on failures |
| `GITHUB_TOKEN` (auto) | n/a | Auto-provided by GitHub Actions; used to push images to GHCR |

To verify: open `https://github.com/kodustech/kodus-ai-quality-gates/settings/secrets/actions` and confirm the 3 names appear.

---

## Final checklist

Before pinging me to trigger the real workflow, confirm:

### Block 0 (minimum)

- [ ] `DIGITALOCEAN_TOKEN` created and added
- [ ] `GH_TEST_TOKEN`, `GH_TEST_REPO`, `GH_TEST_PR_NUMBER` added
- [ ] `SH_LICENSE_KEY_PAID` added to **environment production**
- [ ] `RELEASE_BOT_TOKEN` confirmed present

### Expansion (after Block 0 is green)

- [ ] GitLab bot: `GL_TEST_TOKEN`, `GL_TEST_REPO`, `GL_TEST_MR_IID`
- [ ] Bitbucket bot: `BB_TEST_USER`, `BB_TEST_APP_PASSWORD`, `BB_TEST_REPO`, `BB_TEST_PR_ID`
- [ ] Azure DevOps bot: `AZ_TEST_TOKEN`, `AZ_TEST_ORG`, `AZ_TEST_PROJECT`, `AZ_TEST_REPO`, `AZ_TEST_PR_ID`
- [ ] Self-hosted free license: `SH_LICENSE_KEY_FREE`
- [ ] Cloud tenants: `CLOUD_TENANT_{FREE,TRIAL,PAID}_{EMAIL,PASSWORD}`

### Validation

- [ ] Trigger `selfhosted-build-push.yml` with `version_type=custom` and `custom_version=0.0.0-test`
- [ ] Wait ~25-35 min
- [ ] Confirm a `selfhosted-0.0.0-test-rc.<N>` tag appeared on GHCR
- [ ] Confirm the final `selfhosted-0.0.0-test` tag does **NOT** exist (it should only be created if the matrix is green)
- [ ] Download the `e2e-self-hosted-matrix` artifact and read `summary.md`
- [ ] If everything is green: delete the RC tag, delete the final test tag, delete the release

---

## Quick recovery

| Symptom | Likely cause | Fix |
|---|---|---|
| Workflow fails on "Verify required secrets" | Missing or misnamed secret | Compare the name with the **Variable** column in this doc — case-sensitive |
| GitHub 401 from provider | PAT expired, was revoked, or lost a scope | Regenerate with the scopes from the section |
| GitLab 403 when posting note | PAT missing `api` scope | Regenerate with `api` |
| Bitbucket 401 on basic auth | Wrong username (used Bitbucket username instead of Atlassian email) | Switch to the email |
| Azure DevOps 401 on /threads | PAT missing Code (read & write) | Regenerate with Code read+write |
| Droplet provision 401 | DO token expired or lost `droplet:create` scope | Regenerate with the 6 scopes |
| `Repo not in integration's available list` | Bot account doesn't have the fixture repo connected | Cloud: connect the repo on the tenant first; self-hosted: verify the PAT can see the repo |
| `license-paid + Kody silent` scenario fails | Stack booted but the license wasn't recognized — feature gate blocking | Check the key format and the `API_KODUS_LICENSE_KEY` env in the install's `.env` |
| `license-free + Kody answers` scenario fails (leak) | Real bug: the free license isn't gating code review | This is a product bug the matrix caught — file a ticket |

---

## Credential rotation

When a token expires (90-day default on several providers):

1. Regenerate with the same scopes
2. Update the secret (same name)
3. Done — the next workflow pulls the new value

Recommend a quarterly batch rotation so tokens don't expire at random moments.
