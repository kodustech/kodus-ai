#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

COLLECTION_FILE=${1:-docs-internal/openapi.postman_collection.json}
ENV_FILE=${2:-docs-internal/openapi.postman_environment.json}

if [ ! -f "$COLLECTION_FILE" ]; then
  echo "Collection not found: $COLLECTION_FILE"
  echo "Run: scripts/openapi/generate-postman.sh"
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "Environment not found: $ENV_FILE"
  echo "Create from docs-internal/openapi.postman_environment.example.json"
  exit 1
fi

ENV_FILE="$ENV_FILE" node <<'NODE'
const fs = require('fs');

const envPath = process.env.ENV_FILE;
if (!envPath || !fs.existsSync(envPath)) {
  process.exit(0);
}

const env = JSON.parse(fs.readFileSync(envPath, 'utf8'));
const values = Array.isArray(env.values) ? env.values : [];
const getVal = (key) => values.find((v) => v.key === key)?.value || '';
const setVal = (key, value) => {
  const entry = values.find((v) => v.key === key);
  if (entry) {
    entry.value = value;
  } else {
    values.push({ key, value, enabled: true });
  }
};

const baseUrl = getVal('baseUrl');
const email = getVal('email');
const password = getVal('password');
if (!baseUrl || !email || !password) {
  process.exit(0);
}

const run = async () => {
  try {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const json = await res.json().catch(() => ({}));
    const accessToken = (json && json.accessToken) || (json && json.data && json.data.accessToken);
    const refreshToken = (json && json.refreshToken) || (json && json.data && json.data.refreshToken);
    if (accessToken) {
      setVal('jwt', accessToken);
      setVal('bearerToken', accessToken);
      if (refreshToken) {
        setVal('refreshToken', refreshToken);
      }
      fs.writeFileSync(envPath, JSON.stringify(env, null, 2));
    }
  } catch {
    // best-effort, do not block newman
  }
};

run().then(() => process.exit(0));
NODE

npx --yes newman run "$COLLECTION_FILE" \
  -e "$ENV_FILE" \
  --timeout-request 10000 \
  --timeout-script 10000 \
  --reporters cli,json \
  --reporter-json-export docs-internal/openapi.newman.json

echo "Newman report saved to docs-internal/openapi.newman.json"
