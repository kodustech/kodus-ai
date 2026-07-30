#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f docs-internal/openapi.json ]; then
  echo "docs-internal/openapi.json not found. Run: pnpm run openapi:export"
  exit 1
fi

npx --yes openapi-to-postmanv2 \
  -s docs-internal/openapi.json \
  -o docs-internal/openapi.postman_collection.json \
  -p

node <<'NODE'
const fs = require('fs');
const path = 'docs-internal/openapi.postman_collection.json';
if (!fs.existsSync(path)) {
  process.exit(0);
}
const collection = JSON.parse(fs.readFileSync(path, 'utf8'));
const scriptLines = [
  '// auto-auth: login and set JWT',
  "const currentUrl = pm.request.url.toString();",
  "if (currentUrl.includes('/auth/login')) { return; }",
  "if (!pm.environment.get('jwt') && pm.environment.get('email') && pm.environment.get('password')) {",
  '  pm.sendRequest({',
  "    url: pm.environment.get('baseUrl') + '/auth/login',",
  "    method: 'POST',",
  "    header: { 'Content-Type': 'application/json' },",
  '    body: {',
  "      mode: 'raw',",
  "      raw: JSON.stringify({ email: pm.environment.get('email'), password: pm.environment.get('password') })",
  '    }',
  '  }, function (err, res) {',
  "    if (err) { console.log('Auth error', err); return; }",
  '    let json;',
  '    try { json = res.json(); } catch (e) { return; }',
  "    const accessToken = (json && json.accessToken) || (json && json.data && json.data.accessToken);",
  "    const refreshToken = (json && json.refreshToken) || (json && json.data && json.data.refreshToken);",
  "    if (accessToken) {",
  "      pm.environment.set('jwt', accessToken);",
  "      pm.environment.set('bearerToken', accessToken);",
  "    }",
  "    if (refreshToken) { pm.environment.set('refreshToken', refreshToken); }",
  "    postman.setNextRequest(pm.info.requestName);",
  '  });',
  "  if (pm.execution && pm.execution.skipRequest) { pm.execution.skipRequest(); }",
  '}',
];

const autoAuthEvent = {
  listen: 'prerequest',
  script: { type: 'text/javascript', exec: scriptLines },
};

collection.event = collection.event || [];
const existingIndex = collection.event.findIndex(
  (evt) =>
    evt.listen === 'prerequest' &&
    evt.script &&
    Array.isArray(evt.script.exec) &&
    evt.script.exec.some((line) => line.includes('auto-auth: login and set JWT')),
);
if (existingIndex >= 0) {
  collection.event[existingIndex] = autoAuthEvent;
} else {
  collection.event.push(autoAuthEvent);
}

collection.auth = {
  type: 'bearer',
  bearer: [{ key: 'token', value: '{{jwt}}', type: 'string' }],
};

const replacements = {
  teamId: '{{teamId}}',
  organizationId: '{{organizationId}}',
  repositoryId: '{{repositoryId}}',
  repositoryName: '{{repositoryName}}',
  userId: '{{userId}}',
  targetUserId: '{{targetUserId}}',
  directoryId: '{{directoryId}}',
  ruleId: '{{ruleId}}',
  keyId: '{{keyId}}',
  correlationId: '{{correlationId}}',
  prNumber: '{{prNumber}}',
  prUrl: '{{prUrl}}',
  provider: '{{provider}}',
  number: '{{number}}',
  page: '{{page}}',
  perPage: '{{perPage}}',
  limit: '{{limit}}',
  skip: '{{skip}}',
  startDate: '{{startDate}}',
  endDate: '{{endDate}}',
  beforeAt: '{{beforeAt}}',
  afterAt: '{{afterAt}}',
  window: '{{window}}',
  hours: '{{hours}}',
  organizationSelected: '{{organizationSelected}}',
  isSelected: '{{isSelected}}',
  configType: '{{configType}}',
  protocol: '{{protocol}}',
  active: '{{active}}',
  codeReviewVersion: '{{codeReviewVersion}}',
  integrationCategory: '{{integrationCategory}}',
  models: '{{models}}',
  model: '{{model}}',
  timezone: '{{timezone}}',
  developer: '{{developer}}',
  byok: '{{byok}}',
  branch: '{{branch}}',
  author: '{{author}}',
  state: '{{state}}',
  domain: '{{domain}}',
  q: '{{q}}',
  repositoryIds: '{{repositoryId}}',
  hasSentSuggestions: '{{hasSentSuggestions}}',
  pullRequestTitle: '{{pullRequestTitle}}',
  pullRequestNumber: '{{pullRequestNumber}}',
  format: '{{format}}',
  severity: '{{severity}}',
  category: '{{category}}',
  tags: '{{tags}}',
  buckets: '{{buckets}}',
  plug_and_play: '{{plug_and_play}}',
  language: '{{language}}',
  sampleSize: '{{sampleSize}}',
  userEmail: '{{userEmail}}',
};

const isPlaceholder = (value) =>
  value === '' ||
  value === '<string>' ||
  value === '<email>' ||
  value === '<number>' ||
  value === '<boolean>' ||
  value === '<dateTime>';

const bodyReplacements = {
  email: '{{email}}',
  password: '{{password}}',
  refreshToken: '{{refreshToken}}',
  token: '{{token}}',
  newPassword: '{{newPassword}}',
  teamId: '{{teamId}}',
  organizationId: '{{organizationId}}',
  repositoryId: '{{repositoryId}}',
  repositoryName: '{{repositoryName}}',
  prNumber: '{{prNumber}}',
  prUrl: '{{prUrl}}',
  ruleId: '{{ruleId}}',
  keyId: '{{keyId}}',
  userId: '{{userId}}',
  targetUserId: '{{targetUserId}}',
  directoryId: '{{directoryId}}',
  provider: '{{provider}}',
  configType: '{{configType}}',
};

const applyHeaderDefaults = (item) => {
  if (item && item.request && Array.isArray(item.request.header)) {
    item.request.header = item.request.header.map((header) => {
      if (!header || !header.key) {
        return header;
      }
      if (
        header.key.toLowerCase() === 'x-team-key' &&
        (!header.value || header.value === '')
      ) {
        return { ...header, value: '{{teamKey}}' };
      }
      return header;
    });
  }
  if (item && item.request && item.request.url) {
    const url = item.request.url;
    const pathValue = Array.isArray(url.path) ? url.path.join('/') : url.path || '';
    if (pathValue.includes('mcp')) {
      const hasAccept = item.request.header?.some((h) => h.key?.toLowerCase() === 'accept');
      if (!hasAccept) {
        item.request.header = item.request.header || [];
        item.request.header.push({
          key: 'Accept',
          value:
            item.request.method === 'GET'
              ? 'text/event-stream'
              : 'application/json, text/event-stream',
        });
      }
    }
    if (pathValue.includes('dry-run/events')) {
      const hasAccept = item.request.header?.some((h) => h.key?.toLowerCase() === 'accept');
      if (!hasAccept) {
        item.request.header = item.request.header || [];
        item.request.header.push({ key: 'Accept', value: 'text/event-stream' });
      }
    }
    if (Array.isArray(url.query)) {
      url.query = url.query.map((q) => {
        if (!q || !q.key) {
          return q;
        }
        const replacement = replacements[q.key];
        if (replacement && (q.value === undefined || isPlaceholder(q.value))) {
          return { ...q, value: replacement };
        }
        return q;
      });
    }
    if (Array.isArray(url.variable)) {
      url.variable = url.variable.map((v) => {
        if (!v || !v.key) {
          return v;
        }
        const replacement = replacements[v.key];
        if (replacement && (v.value === undefined || isPlaceholder(v.value))) {
          return { ...v, value: replacement };
        }
        return v;
      });
    }
  }
  if (item && item.request && item.request.body && item.request.body.mode === 'raw') {
    const raw = item.request.body.raw;
    if (typeof raw === 'string' && raw.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        let changed = false;
        Object.keys(parsed).forEach((key) => {
          if (Object.prototype.hasOwnProperty.call(bodyReplacements, key) && isPlaceholder(parsed[key])) {
            parsed[key] = bodyReplacements[key];
            changed = true;
          }
        });
        if (changed) {
          item.request.body.raw = JSON.stringify(parsed, null, 2);
        }
      } catch {
        // ignore non-JSON bodies
      }
    }
  }
  if (item && Array.isArray(item.item)) {
    item.item.forEach(applyHeaderDefaults);
  }
};

if (Array.isArray(collection.item)) {
  collection.item.forEach(applyHeaderDefaults);
}

fs.writeFileSync(path, JSON.stringify(collection, null, 2));
NODE

if [ ! -f docs-internal/openapi.postman_environment.example.json ]; then
  cat <<'JSON' > docs-internal/openapi.postman_environment.example.json
{
  "name": "local",
  "values": [
    { "key": "baseUrl", "value": "http://localhost:3001", "enabled": true },
    { "key": "jwt", "value": "", "enabled": true },
    { "key": "bearerToken", "value": "", "enabled": true },
    { "key": "teamKey", "value": "", "enabled": true },
    { "key": "email", "value": "", "enabled": true },
    { "key": "password", "value": "", "enabled": true },
    { "key": "organizationId", "value": "", "enabled": true },
    { "key": "teamId", "value": "", "enabled": true },
    { "key": "repositoryId", "value": "", "enabled": true },
    { "key": "repositoryName", "value": "", "enabled": true },
    { "key": "userId", "value": "", "enabled": true },
    { "key": "targetUserId", "value": "", "enabled": true },
    { "key": "directoryId", "value": "", "enabled": true },
    { "key": "ruleId", "value": "", "enabled": true },
    { "key": "keyId", "value": "", "enabled": true },
    { "key": "correlationId", "value": "", "enabled": true },
    { "key": "prNumber", "value": "", "enabled": true }
  ]
}
JSON
fi

echo "Postman collection generated at docs-internal/openapi.postman_collection.json"
