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
WRITER=quality-signals-writer
READER=quality-dashboard-reader
REPOS=(kodustech/kodus-ai kodustech/kodus-quality)
GH_VAR_REPOS=(kodustech/kodus-ai)           # kodus-quality gets its variables when it exists

gcloud config set project "$PROJECT" >/dev/null
PN=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
WRITER_SA="$WRITER@$PROJECT.iam.gserviceaccount.com"
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
for sa in "$WRITER:Quality signals writer (GitHub Actions via WIF)" "$READER:Quality dashboard reader"; do
  id=${sa%%:*}; name=${sa#*:}
  if gcloud iam service-accounts describe "$id@$PROJECT.iam.gserviceaccount.com" >/dev/null 2>&1; then echo "$id exists"; else
    gcloud iam service-accounts create "$id" --display-name="$name"
  fi
done

step "Dataset access (writer=WRITER, reader=READER)"
tmp=$(mktemp)
bq show --format=prettyjson "$PROJECT:$DATASET" > "$tmp"
python3 - "$tmp" "$WRITER_SA" "$READER_SA" <<'PY'
import json, sys
path, writer, reader = sys.argv[1:]
ds = json.load(open(path))
want = [{"role": "WRITER", "userByEmail": writer}, {"role": "READER", "userByEmail": reader}]
for w in want:
    if w not in ds["access"]:
        ds["access"].append(w)
json.dump({"access": ds["access"]}, open(path, "w"))
PY
bq update --source "$tmp" "$PROJECT:$DATASET" >/dev/null && echo "ok"

step "Project role: bigquery.jobUser (both SAs can run queries/inserts)"
for sa in "$WRITER_SA" "$READER_SA"; do
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

step "Let each repo's workflows impersonate the writer"
for repo in "${REPOS[@]}"; do
  gcloud iam service-accounts add-iam-policy-binding "$WRITER_SA" \
    --role=roles/iam.workloadIdentityUser \
    --member="principalSet://iam.googleapis.com/projects/$PN/locations/global/workloadIdentityPools/$POOL/attribute.repository/$repo" \
    --quiet >/dev/null && echo "$repo"
done

step "GitHub repo variables"
for repo in "${GH_VAR_REPOS[@]}"; do
  gh variable set GCP_WIF_PROVIDER --repo "$repo" --body "$PROVIDER_NAME"
  gh variable set GCP_SA_EMAIL     --repo "$repo" --body "$WRITER_SA"
  gh variable set GCP_PROJECT      --repo "$repo" --body "$PROJECT"
  echo "$repo"
done

step "Done"
echo "GCP_WIF_PROVIDER=$PROVIDER_NAME"
echo "GCP_SA_EMAIL=$WRITER_SA"
echo "reader SA (no key yet; T6 creates it where the dashboard deploys): $READER_SA"
