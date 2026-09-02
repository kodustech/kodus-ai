#!/usr/bin/env node
/**
 * Rebuild `libs/llm/testing/__fixtures__/byok-prod-shapes.json` from a raw dump
 * of production BYOK configs.
 *
 * WHY THIS EXISTS
 * The fixture is the corpus the config matrix replays — every distinct shape a
 * customer has stored. It was built ONCE, by hand, from an ad-hoc dump. That is
 * the same defect as the context-window mirror before it got a refresh script: a
 * snapshot nobody can regenerate is a snapshot that silently stops describing
 * production, and the matrix keeps reporting green over shapes nobody runs any
 * more while new ones go uncovered.
 *
 * ── THE QUERY ────────────────────────────────────────────────────────────────
 * `scripts/sql/byok-prod-shapes.sql` — versioned beside this file rather than
 * pasted into a comment, so there is one copy of it and it can actually be run:
 *
 *   psql "$PROD_REPLICA_URL" -At -f scripts/sql/byok-prod-shapes.sql > dump.json
 *
 * It filters to organizations that still have an ACTIVE auth_integration, so a
 * churned customer's config stops driving the matrix. The credential fields are
 * redacted there too; this script strips them again and refuses to write a
 * fixture that still contains one.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *   node scripts/refresh-byok-prod-shapes.mjs <dump.json>           # write
 *   node scripts/refresh-byok-prod-shapes.mjs <dump.json> --check   # report only
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'libs/llm/testing/__fixtures__/byok-prod-shapes.json');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const dumpPath = args.find((a) => !a.startsWith('--'));
if (!dumpPath) {
    console.error('usage: refresh-byok-prod-shapes.mjs <dump.json> [--check]');
    process.exit(2);
}

/** Credentials never leave the database, whatever the dump contains. */
const CREDENTIAL_FIELDS = new Set([
    'apiKey',
    'awsBearerToken',
    'awsAccessKeyId',
    'awsSecretAccessKey',
    'awsSessionToken',
]);

/**
 * Hosts that are a VENDOR's public endpoint and carry no customer identity, so
 * the URL is kept verbatim — the endpoint is part of what the matrix tests (the
 * openai_compatible baseURL heuristic keys on it).
 *
 * Matching is by suffix, and the default is to REDACT: an unrecognised host is
 * assumed to be a customer's own proxy. That direction is deliberate — a missed
 * vendor costs one anonymised case, a missed customer host leaks infrastructure.
 */
const PUBLIC_VENDOR_HOSTS = [
    'api.anthropic.com', 'api.openai.com', 'api.deepseek.com',
    'api.moonshot.ai', 'api.moonshot.cn', 'api.kimi.com', 'api.z.ai',
    'api.minimax.io', 'api.minimaxi.com', 'api.novita.ai', 'openrouter.ai',
    'api.fireworks.ai', 'api.groq.com', 'api.together.xyz', 'api.mistral.ai',
    'api.x.ai', 'generativelanguage.googleapis.com', 'amazonaws.com',
    'integrate.api.nvidia.com', 'open.bigmodel.cn', 'ollama.com',
    'nano-gpt.com', 'opencode.ai', 'xiaomimimo.com', 'localhost', '127.0.0.1',
];

/**
 * Vendor domains whose SUBDOMAIN is chosen by the customer. The suffix says
 * which product it is — which the matrix needs, since the openai_compatible
 * baseURL heuristic keys on it — but the label in front is the customer's own
 * resource name and must not ship: `deepxl-ml-resource.openai.azure.com`,
 * `ws-69mw3cf72kmcjgx0.ap-southeast-1.maas.aliyuncs.com`. Listing these was the
 * gap in the first draft of this script, which kept them whole.
 */
const CUSTOMER_SUBDOMAIN_VENDORS = ['openai.azure.com', 'aliyuncs.com'];

const isPublicVendor = (host) =>
    PUBLIC_VENDOR_HOSTS.some(
        (v) => host === v || host.endsWith(`.${v}`) || host.startsWith(`${v}:`),
    );

const redactedHosts = new Map();
const keptHosts = new Set();

function anonymiseUrl(raw) {
    let u;
    try {
        u = new URL(raw);
    } catch {
        return raw.includes('/') ? 'redacted-unparseable' : raw;
    }
    const scoped = CUSTOMER_SUBDOMAIN_VENDORS.find((v) =>
        u.hostname.endsWith(`.${v}`),
    );
    if (scoped) {
        if (!redactedHosts.has(u.host) && !scoped) {
            redactedHosts.set(u.host, `redacted-resource-${redactedHosts.size + 1}.${scoped}`);
        }
    } else if (isPublicVendor(u.hostname)) {
        keptHosts.add(u.host);
        return raw;
    }
    if (!redactedHosts.has(u.host)) {
        // Keep the TLD family: `.workers.dev` vs `.ngrok-free.dev` vs a plain
        // domain are different deployment shapes, and the matrix's baseURL
        // hygiene checks care about the shape, not the name.
        const family = /\.workers\.dev$/.test(u.hostname)
            ? 'workers.dev'
            : /\.ngrok[-.]/.test(u.hostname)
              ? 'ngrok-free.dev'
              : 'example.test';
        redactedHosts.set(u.host, `redacted-${redactedHosts.size + 1}.${family}`);
    }
    // Scheme, port and PATH survive — an endpoint pasted into the baseURL is a
    // real defect class (`/chat/completions` glued on) and lives in the path.
    // The path is kept VERBATIM, trailing slash included. A trailing slash is a
    // real difference in a stored baseURL (it changes how the SDK joins the
    // path), so normalising it here would merge two configs the runtime treats
    // as different — the first draft of this script did exactly that.
    return `${u.protocol}//${redactedHosts.get(u.host)}${u.port ? `:${u.port}` : ''}${u.pathname}${u.search}`;
}

function cleanSlot(slot) {
    const out = {};
    for (const [k, v] of Object.entries(slot)) {
        if (CREDENTIAL_FIELDS.has(k)) continue;
        if (v === null || v === undefined || v === '') continue;
        out[k] = k === 'baseURL' && typeof v === 'string' ? anonymiseUrl(v) : v;
    }
    return out;
}

const raw = JSON.parse(readFileSync(dumpPath, 'utf8'));
const rows = Array.isArray(raw) ? raw : (raw.rows ?? []);

/** shape signature -> { slot, orgs } — orgs is a COUNT, never an id. */
const byShape = new Map();
let slotCount = 0;
for (const row of rows) {
    const cv = row?.configValue;
    if (!cv || typeof cv !== 'object') continue;
    for (const position of ['main', 'fallback']) {
        const slot = cv[position];
        if (!slot || typeof slot !== 'object') continue;
        slotCount++;
        const clean = cleanSlot(slot);
        if (!clean.provider || !clean.model) continue;
        // Sorted keys so two equal configs written in a different order are ONE
        // shape; every surviving field is part of the signature, so a config
        // that differs only in maxConcurrentRequests stays a distinct case.
        const sig = JSON.stringify(
            Object.fromEntries(Object.entries(clean).sort(([a], [b]) => a.localeCompare(b))),
        );
        const hit = byShape.get(sig);
        if (hit) hit.orgs++;
        else byShape.set(sig, { ...clean, orgs: 1 });
    }
}

const shapes = [...byShape.values()].sort((a, b) =>
    `${a.provider}${a.model}`.localeCompare(`${b.provider}${b.model}`),
);

// Refuse to emit anything that still looks like a credential or an org id.
const blob = JSON.stringify(shapes);
const leaks = [];
for (const f of CREDENTIAL_FIELDS) if (blob.includes(`"${f}"`)) leaks.push(f);
const uuids = blob.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi);
if (uuids) leaks.push(`${new Set(uuids).size} uuid(s)`);
if (leaks.length) {
    console.error(`refusing to write — the output still contains: ${leaks.join(', ')}`);
    process.exit(1);
}

const current = JSON.parse(readFileSync(TARGET, 'utf8'));
const sigOf = (s) => {
    const { orgs: _o, ...rest } = s;
    return JSON.stringify(Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b))));
};
const currentSigs = new Set(current.map(sigOf));
const nextSigs = new Set(shapes.map(sigOf));
const added = shapes.filter((s) => !currentSigs.has(sigOf(s)));
const gone = current.filter((s) => !nextSigs.has(sigOf(s)));

console.log(`rows ${rows.length} -> slots ${slotCount} -> distinct shapes ${shapes.length}`);
console.log(`committed fixture: ${current.length}  (+${added.length} new / -${gone.length} absent)`);
console.log(`hosts kept verbatim: ${keptHosts.size}, redacted: ${redactedHosts.size}`);
for (const s of added.slice(0, 20)) console.log(`  NEW  ${s.provider}/${s.model}`);
if (added.length > 20) console.log(`  ... and ${added.length - 20} more`);

if (checkOnly) {
    // A NEW shape is the signal: production grew a config the matrix never
    // replays. A shape going absent is normal churn (a customer changed a
    // setting) and must not fail a check, or the job becomes noise.
    process.exit(added.length ? 1 : 0);
}

writeFileSync(TARGET, JSON.stringify(shapes) + '\n');
console.log(`wrote ${TARGET}`);
