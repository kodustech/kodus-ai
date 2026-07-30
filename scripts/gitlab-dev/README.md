# gitlab-dev — self-hosted GitLab fixture for local testing

Spins up a single-node `gitlab-ce` container on the
`kodus-backend-services` docker network and lets you bring up the
test data in steps so you can browse between them.

The seed produces:

- a test user (`kodus-dev`)
- a private group + project (`kodus-playground/discount-service`)
- a small but real TypeScript service on `main`
- an open merge request from `feat/discount-codes` → `main` that
  carries five deliberate review-worthy issues (missing `await`,
  unvalidated input into a `Record` indexer, hardcoded admin secret,
  loose `==` + magic number, unused import + stale TODO) — enough
  surface that a reviewer is virtually guaranteed to produce at least
  one suggestion
- a personal access token (`api`, `read_repository`, `write_repository`)
  written to `.tmp/gitlab-dev-pat.txt`

**Development only.** No production data, no production credentials,
no telemetry. The root password is hardcoded (`KodusDev!2026`), the
instance listens on `gitlab.lvh.me:8929`, and `destroy.sh` wipes
everything.

## Prerequisites

```sh
# Creates the kodus-backend-services network that compose attaches to
pnpm run docker:start
```

Roughly 4 GB free RAM and 3 GB free disk for the GitLab volumes.

## Step-by-step usage

Each script is idempotent and safe to re-run.

```sh
# 1. Boot. First time takes 2-5 minutes (gitlab-ce reconfigure).
#    Browse it at http://gitlab.lvh.me:8929  (root / KodusDev!2026)
bash scripts/gitlab-dev/start.sh

# 2. Create the test user, group, project, and seed main.
#    Mints a user PAT into .tmp/gitlab-dev-pat.txt.
bash scripts/gitlab-dev/create-project.sh

# 3. Push the feature branch and open the review MR.
bash scripts/gitlab-dev/create-mr.sh

# Or run all three back-to-back:
bash scripts/gitlab-dev/run.sh

# Tear down (removes volumes and .tmp artefacts):
bash scripts/gitlab-dev/destroy.sh
```

## Wiring into the Kodus dev stack

Register a self-hosted GitLab integration in the Kodus UI with:

| field | value |
|---|---|
| host  | `http://gitlab.lvh.me:8929` |
| token | contents of `.tmp/gitlab-dev-pat.txt` |

The `host` field is what unlocks the self-hosted code path in
`gitlab.service.ts` (`normalizeGitlabHost` / `getGitlabWebBaseUrl`).
Without it the GitLab client defaults to `gitlab.com`.

## Webhooks — keep using your existing URL

The compose enables
`gitlab_rails['allow_local_requests_from_web_hooks_and_services']`,
so GitLab will POST to **any** target you give it:

- a public tunnel (zrok / ngrok) — works as-is; GitLab has internet
- `http://kodus-api:3001/gitlab/webhook` — for the docker dev stack
- `http://host.docker.internal:3001/gitlab/webhook` — for `pnpm run start:dev` on the host

You generally don't need to change anything: when you connect the
integration in the Kodus UI, Kodus registers the webhook itself using
whatever `API_GITLAB_CODE_MANAGEMENT_WEBHOOK` you already have set
(e.g. your zrok URL).

If you want to pre-wire a webhook directly on the GitLab side
(skipping the Kodus UI step — useful when you're testing GitLab → API
delivery in isolation), pass `WEBHOOK_URL` to `create-project.sh`:

```sh
WEBHOOK_URL="https://abcd-1234.share.zrok.io/gitlab/webhook" \
    bash scripts/gitlab-dev/create-project.sh
```

The script will create a project hook for `merge_requests_events` and
`note_events` pointing at that URL. Re-running with a different value
replaces the previous hook.

## Pinning the GitLab version

The compose image is overridable via `GITLAB_IMAGE`. Two pins worth
keeping in muscle memory:

| pin | exercises |
|---|---|
| `gitlab/gitlab-ce:latest` (default)        | happy path + regression check, plus the CE-403 graceful path on `unapprove` |
| `gitlab/gitlab-ce:15.6.5-ce.0`             | last release before the `/diffs` endpoint (15.7) — exercises the showChanges fallback |
| `gitlab/gitlab-ce:13.12.15-ce.0`           | 13.x Note Hook shape — webhooks may omit `object_attributes.action` and `discussion_id` |

```sh
GITLAB_IMAGE=gitlab/gitlab-ce:13.12.15-ce.0 bash scripts/gitlab-dev/run.sh
```

Older images also lack the `admin_mode` PAT scope (added in 17.5).
`_common.sh` handles that automatically — it tries with `admin_mode`
first and retries without it on `ActiveRecord::RecordInvalid`.

## Common test scenarios

Each recipe assumes the dev stack is up and `WEBHOOK_URL` points at
your Kodus API (zrok tunnel, `kodus-api:3001`, etc.).

### Regression check on a current GitLab

```sh
bash scripts/gitlab-dev/run.sh   # default = gitlab-ce:latest
```

Register the integration in Kodus, trigger a review on the seeded MR.
The MR carries a hardcoded `ADMIN_TOKEN` and a missing `await` — both
reliable critical hits — so the critical-issues code path should
engage even on a current GitLab CE.

### Validating GitLab < 15.7 compatibility (older diffs endpoint)

```sh
bash scripts/gitlab-dev/destroy.sh   # only if previously booted with another pin
GITLAB_IMAGE=gitlab/gitlab-ce:15.6.5-ce.0 \
    WEBHOOK_URL="<your-kodus-webhook>" \
    bash scripts/gitlab-dev/run.sh
```

Trigger a review. Confirm in the API logs that `MergeRequests.allDiffs`
404s and the code falls through to `showChanges` (the older endpoint
available on pre-15.7 instances). The review should still complete and
produce suggestions.

### Validating GitLab 13.x webhook payloads

13.x Note Hook payloads omit `object_attributes.action` and may also
omit `object_attributes.discussion_id`, so this is the pin to use for
shaking out any "missing field on the webhook" assumption in handlers
or the chat-with-Kody paths.

```sh
GITLAB_IMAGE=gitlab/gitlab-ce:13.12.15-ce.0 \
    WEBHOOK_URL="<your-kodus-webhook>" \
    bash scripts/gitlab-dev/run.sh

bash scripts/gitlab-dev/post-comment.sh --body "@kody start-review"
```

Confirm the comment is received and routed. Optionally, manually post
a comment on an *issue* through the UI and confirm it's ignored — that
exercises the noteable-type gate that filters out non-MR notes.

### Validating `unapprove` graceful fallback (CE without Premium)

`gitlab-ce:latest` has no Premium license, so any code path that calls
`MergeRequestApprovals.unapprove` will get a 403. That makes the
default fixture a natural place to confirm the surrounding flow keeps
working — e.g. that follow-up actions (posting a discussion comment,
marking the review status) still complete.

```sh
bash scripts/gitlab-dev/run.sh   # default = gitlab-ce:latest
# Trigger a review that detects critical issues; verify the unapprove
# error is logged as a warning and the follow-up actions still run.
```

## Anatomy

```
docker/gitlab-dev/
  docker-compose.yml       gitlab-ce (overridable via GITLAB_IMAGE), hostname gitlab.lvh.me
scripts/gitlab-dev/
  _common.sh               shared env + admin-PAT caching + curl helpers
  start.sh                 step 1 — boot compose + wait for /-/health
  create-project.sh        step 2 — user/group/project/seed/PAT (+optional webhook)
  create-mr.sh             step 3 — feature branch + open MR
  post-comment.sh          post a comment as kodus-dev on the seeded MR
  run.sh                   start + create-project + create-mr in sequence
  destroy.sh               compose down -v + clean .tmp artefacts
```

The admin PAT is minted via `gitlab-rails runner` inside the container
(stable across versions; the OAuth password grant has been getting
locked down in 16.x) and cached at `.tmp/gitlab-dev-admin-pat.txt`.
Subsequent script runs reuse it as long as it's still valid.
