#!/usr/bin/env bash
# T0 of docs/quality-signals-plan.md: the GCP side of quality.signals.
# Idempotent: every step checks before it creates. Needs gcloud authed as an
# owner of kody-408918 and gh authed with repo scope on kodustech/kodus-ai.
#
#   bash scripts/quality/bootstrap-gcp.sh
set -euo pipefail

PROJECT=kody-408918
LOCATION=northamerica-northeast1          # same region as the prod mirror datasets, so joins work
DATASET=quality
POOL=github
PROVIDER=github
WRITER=quality-signals-writer             # kodus-ai CI: writes quality.signals, nothing else
PULL=quality-pull                         # kodus-quality pull + kodus-insights: writes signals, READS the prod mirror
READER=quality-dashboard-reader           # dashboard (key on Railway): reads quality only
# Two identities on purpose: PR-triggered workflows in kodus-ai run PR-controlled code with
# id-token: write, so whatever the writer can reach, any PR can reach. The mirror
# (kodus_mongo / kodus_postgres = prod data) is therefore readable only by the pull SA,
# which only the two scheduled-job repos can impersonate.
WRITER_REPOS=(kodustech/kodus-ai)
PULL_REPOS=(kodustech/kodus-quality kodustech/kodus-insights)
MIRRORS=(kodus_mongo kodus_postgres)

gcloud config set project "$PROJECT" >/dev/null
PN=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
WRITER_SA="$WRITER@$PROJECT.iam.gserviceaccount.com"
PULL_SA="$PULL@$PROJECT.iam.gserviceaccount.com"
READER_SA="$READER@$PROJECT.iam.gserviceaccount.com"

step() { printf '\n== %s\n' "$*"; }

step "APIs"
gcloud services enable sts.googleapis.com iamcredentials.googleapis.com iam.googleapis.com bigquery.googleapis.com

step "Dataset $DATASET ($LOCATION)"
if bq show "$PROJECT:$DATASET" >/dev/null 2>&1; then echo "exists"; else
  bq --location="$LOCATION" mk --dataset \
    --description "Quality signals: one row per signal per run. Contract in kodus-ai docs/quality-signals.md" \
    "$PROJECT:$DATASET"
fi

step "Service accounts"
for sa in "$WRITER:Quality signals writer (kodus-ai CI via WIF)" "$PULL:Quality pull (kodus-quality, kodus-insights via WIF; reads the prod mirror)" "$READER:Quality dashboard reader"; do
  id=${sa%%:*}; name=${sa#*:}
  if gcloud iam service-accounts describe "$id@$PROJECT.iam.gserviceaccount.com" >/dev/null 2>&1; then echo "$id exists"; else
    gcloud iam service-accounts create "$id" --display-name="$name"
  fi
done

step "Dataset access: $DATASET (writer=WRITER, pull=WRITER, reader=READER)"
tmp=$(mktemp)
bq show --format=prettyjson "$PROJECT:$DATASET" > "$tmp"
python3 - "$tmp" "$WRITER_SA" "$PULL_SA" "$READER_SA" <<'PY'
import json, sys
path, writer, pull, reader = sys.argv[1:]
ds = json.load(open(path))
want = [{"role": "WRITER", "userByEmail": writer}, {"role": "WRITER", "userByEmail": pull}, {"role": "READER", "userByEmail": reader}]
for w in want:
    if w not in ds["access"]:
        ds["access"].append(w)
json.dump({"access": ds["access"]}, open(path, "w"))
PY
bq update --source "$tmp" "$PROJECT:$DATASET" >/dev/null && echo "ok"

step "Mirror datasets (pull=READER only): thumbs-down, suggestions, Kody Rules and org names for the nightly pull"
for mirror in "${MIRRORS[@]}"; do
  # Like the quality dataset above: a missing or unreadable mirror (fresh project,
  # Airbyte not provisioned) must not abort jobUser, WIF and the repo variables.
  if ! bq show --format=prettyjson "$PROJECT:$mirror" > "$tmp" 2>/dev/null; then
    echo "skip: $PROJECT:$mirror not readable (Airbyte mirror not provisioned yet?)" >&2
    continue
  fi
  python3 - "$tmp" "$PULL_SA" "$WRITER_SA" <<'PY'
import json, sys
path, pull, writer = sys.argv[1:]
ds = json.load(open(path))
access = [a for a in ds.get("access", []) if a.get("userByEmail") != writer]  # the CI writer never reads prod data
want = {"role": "READER", "userByEmail": pull}
if want not in access:
    access.append(want)
json.dump({"access": access}, open(path, "w"))
PY
  bq update --source "$tmp" "$PROJECT:$mirror" >/dev/null && echo "$mirror ok"
done

step "Mirror datasets (writer=READER): the pull reads thumbs-down, suggestions and org names from the Airbyte mirror"
for mirror in kodus_mongo kodus_postgres; do
  bq show --format=prettyjson "$PROJECT:$mirror" > "$tmp"
  python3 - "$tmp" "$WRITER_SA" <<'PY2'
import json, sys
path, writer = sys.argv[1:]
ds = json.load(open(path))
want = {"role": "READER", "userByEmail": writer}
if want not in ds["access"]:
    ds["access"].append(want)
json.dump({"access": ds["access"]}, open(path, "w"))
PY2
  bq update --source "$tmp" "$PROJECT:$mirror" >/dev/null && echo "$mirror ok"
done

step "Project role: bigquery.jobUser (every SA can run queries/inserts)"
for sa in "$WRITER_SA" "$PULL_SA" "$READER_SA"; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$sa" \
    --role=roles/bigquery.jobUser --condition=None --quiet >/dev/null && echo "$sa"
done

step "Workload Identity pool/provider for GitHub Actions"
if gcloud iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1; then echo "pool exists"; else
  gcloud iam workload-identity-pools create "$POOL" --location=global --display-name="GitHub Actions"
fi
if gcloud iam workload-identity-pools providers describe "$PROVIDER" --location=global --workload-identity-pool="$POOL" >/dev/null 2>&1; then echo "provider exists"; else
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --location=global --workload-identity-pool="$POOL" --display-name="GitHub" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
    --attribute-condition="assertion.repository_owner=='kodustech'"
fi
PROVIDER_NAME="projects/$PN/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"

member_of() { echo "principalSet://iam.googleapis.com/projects/$PN/locations/global/workloadIdentityPools/$POOL/attribute.repository/$1"; }

step "Impersonation: kodus-ai -> writer; kodus-quality, kodus-insights -> pull"
for repo in "${WRITER_REPOS[@]}"; do
  gcloud iam service-accounts add-iam-policy-binding "$WRITER_SA" --role=roles/iam.workloadIdentityUser --member="$(member_of "$repo")" --quiet >/dev/null && echo "$repo -> $WRITER"
done
for repo in "${PULL_REPOS[@]}"; do
  gcloud iam service-accounts add-iam-policy-binding "$PULL_SA" --role=roles/iam.workloadIdentityUser --member="$(member_of "$repo")" --quiet >/dev/null && echo "$repo -> $PULL"
  # Earlier versions let these repos impersonate the writer too; a repo has one identity.
  gcloud iam service-accounts remove-iam-policy-binding "$WRITER_SA" --role=roles/iam.workloadIdentityUser --member="$(member_of "$repo")" --quiet >/dev/null 2>&1 || true
done

step "GitHub repo variables"
set_vars() {
  gh variable set GCP_WIF_PROVIDER --repo "$1" --body "$PROVIDER_NAME"
  gh variable set GCP_SA_EMAIL     --repo "$1" --body "$2"
  gh variable set GCP_PROJECT      --repo "$1" --body "$PROJECT"
  echo "$1 (GCP_SA_EMAIL=$2)"
}
for repo in "${WRITER_REPOS[@]}"; do set_vars "$repo" "$WRITER_SA"; done
for repo in "${PULL_REPOS[@]}"; do set_vars "$repo" "$PULL_SA"; done

step "Done"
echo "GCP_WIF_PROVIDER=$PROVIDER_NAME"
echo "GCP_SA_EMAIL (kodus-ai)=$WRITER_SA"
echo "GCP_SA_EMAIL (kodus-quality, kodus-insights)=$PULL_SA"
echo "reader SA (no key yet; T6 creates it where the dashboard deploys): $READER_SA"
