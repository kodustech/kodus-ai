/**
 * One-shot migration tool: bring an existing local .env in line with the
 * current .env.schema while preserving as much of the user's data as
 * possible.
 *
 *   pnpm run env:reconcile [--source <path>] [--output <path>]
 *
 * Default source:  ./.env  (the one running the app right now)
 * Default output:  ./.env.reconciled  (review before replacing .env)
 *
 * What it does:
 *   1. Snapshots the source verbatim to ~/kodus-env-snapshot-<ts>.env
 *      so nothing can ever be silently lost.
 *   2. Reads every var from the schema and emits a new .env where:
 *        - If you already have the key with a non-empty value → keep yours.
 *        - If you only have an older RENAMED-FROM key (e.g.
 *          API_JWT_REFRESHSECRET → API_JWT_REFRESH_SECRET) → migrate
 *          the value to the new key.
 *        - Otherwise → fall back to the schema default (often empty for
 *          secrets, which is the cue to populate them from 1Password).
 *   3. Appends a trailing comment block listing every key in your source
 *      that the schema no longer recognises, with its old value, so a
 *      human can sanity-check whether anything important is being
 *      dropped (e.g. truly local overrides).
 *
 * After running:
 *   diff .env .env.reconciled    # inspect
 *   mv .env.reconciled .env      # adopt
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { flatten, parseSchema, SchemaItem } from './parse-schema';

const REPO_ROOT = join(__dirname, '..', '..');
const SCHEMA_PATH = join(REPO_ROOT, '.env.schema');

// Known historic renames in the kodus-ai schema. New canonical name → list of
// older names whose value should migrate forward. Order matters: first found
// non-empty old value wins. Add to this list any time you rename a key in
// the schema.
const RENAMES: Record<string, string[]> = {
    API_JWT_REFRESH_SECRET: ['API_JWT_REFRESHSECRET'],
    API_OPEN_ROUTER_API_KEY: ['API_OPENROUTER_KEY'],
    API_MORPHLLM_API_KEY: ['MORPH_API_KEY'],
    API_BETTERSTACK_DSN: ['API_SENTRY_DNS'],
};

function parseArgs(argv: string[]) {
    let source = join(REPO_ROOT, '.env');
    let output = join(REPO_ROOT, '.env.reconciled');
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--source' && argv[i + 1]) source = argv[++i];
        else if (argv[i] === '--output' && argv[i + 1]) output = argv[++i];
    }
    return { source, output };
}

function parseDotenv(path: string): Map<string, string> {
    const out = new Map<string, string>();
    if (!existsSync(path)) return out;
    const text = readFileSync(path, 'utf-8');
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
        if (!m) continue;
        const [, key, rawValue] = m;
        out.set(key, stripQuotes(rawValue));
    }
    return out;
}

function stripQuotes(v: string): string {
    const t = v.trim();
    if (
        (t.startsWith('"') && t.endsWith('"')) ||
        (t.startsWith("'") && t.endsWith("'"))
    ) {
        return t.slice(1, -1);
    }
    return t;
}

function needsQuotes(value: string): boolean {
    return /[\s#"']/.test(value);
}

function emit(name: string, value: string): string {
    return `${name}=${needsQuotes(value) ? `"${value}"` : value}`;
}

function timestamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main(): void {
    const { source, output } = parseArgs(process.argv.slice(2));

    if (!existsSync(source)) {
        console.error(`error: source .env not found at ${source}`);
        process.exit(1);
    }

    // ── 1. Snapshot ──────────────────────────────────────────────────────
    const snapshotPath = join(
        homedir(),
        `kodus-env-snapshot-${timestamp()}.env`,
    );
    writeFileSync(snapshotPath, readFileSync(source, 'utf-8'));

    const userEnv = parseDotenv(source);
    const schema = flatten(parseSchema(SCHEMA_PATH));
    const schemaKeys = new Set(schema.map((it) => it.name));

    // ── 2. Reconcile ─────────────────────────────────────────────────────
    const kept: string[] = [];
    const migrated: { from: string; to: string }[] = [];
    const filledFromSchema: string[] = [];

    const lines: string[] = [
        '# RECONCILED from .env.schema by scripts/env/reconcile.ts.',
        `# Source:   ${source}`,
        `# Snapshot: ${snapshotPath}`,
        '# Review with: diff .env .env.reconciled',
        '',
    ];

    let lastSection = '';
    for (const item of schema) {
        if (item.section !== lastSection) {
            lines.push('');
            lines.push(`# ============================================================`);
            lines.push(`# ${item.section}`);
            lines.push(`# ============================================================`);
            lastSection = item.section;
        }

        const resolved = resolveValue(item, userEnv);
        if (resolved.source === 'user') kept.push(item.name);
        else if (resolved.source === 'migrated') {
            migrated.push({ from: resolved.from!, to: item.name });
        } else if (resolved.source === 'schema') {
            filledFromSchema.push(item.name);
        }

        lines.push(emit(item.name, resolved.value));
    }

    // ── 3. Quarantine dropped keys ───────────────────────────────────────
    const dropped: string[] = [];
    for (const [key, value] of userEnv) {
        if (schemaKeys.has(key)) continue;
        if (isRenameSource(key)) continue; // already migrated forward
        dropped.push(key);
        // Don't bother recording empty stale keys — they carry no info.
        if (value === '') continue;
    }

    if (dropped.length > 0) {
        lines.push('');
        lines.push(`# ============================================================`);
        lines.push(`# DROPPED — keys in your old .env that the schema no longer knows.`);
        lines.push(`# They are NOT loaded by the app (the code that read them is gone).`);
        lines.push(`# Listed for audit. Delete this block once you've sanity-checked.`);
        lines.push(`# Original values preserved in ${snapshotPath}.`);
        lines.push(`# ============================================================`);
        for (const key of dropped) {
            const v = userEnv.get(key) ?? '';
            lines.push(`# ${key}=${needsQuotes(v) ? `"${v}"` : v}`);
        }
    }

    writeFileSync(output, lines.join('\n') + '\n');

    // ── 4. Summary ───────────────────────────────────────────────────────
    console.log(`Snapshot:    ${snapshotPath}`);
    console.log(`Reconciled:  ${output}`);
    console.log(`Source vars: ${userEnv.size}`);
    console.log(`Schema vars: ${schema.length}`);
    console.log(`Kept:        ${kept.length} (your value preserved)`);
    console.log(`Migrated:    ${migrated.length} (renamed key, value carried forward)`);
    for (const { from, to } of migrated) {
        console.log(`               ${from}  →  ${to}`);
    }
    console.log(`Schema-default: ${filledFromSchema.length} (needs a real value or 1P pull)`);
    console.log(`Dropped:     ${dropped.length} (kept as a commented audit block)`);
    console.log();
    console.log(`Next: diff .env ${output}  →  if good, mv ${output} .env`);
    console.log(`Then: pnpm run env:pull   (once the 1P vault is populated)`);
}

type Resolved =
    | { source: 'user'; value: string }
    | { source: 'migrated'; value: string; from: string }
    | { source: 'schema'; value: string };

function resolveValue(item: SchemaItem, userEnv: Map<string, string>): Resolved {
    // Prefer the user's existing value if they have a non-empty one.
    const current = userEnv.get(item.name);
    if (current !== undefined && current !== '') {
        return { source: 'user', value: current };
    }

    // Otherwise, see if the user has the value under an older name.
    const oldNames = RENAMES[item.name] ?? [];
    for (const oldName of oldNames) {
        const oldValue = userEnv.get(oldName);
        if (oldValue !== undefined && oldValue !== '') {
            return { source: 'migrated', value: oldValue, from: oldName };
        }
    }

    // Fall back to whatever the schema declared as the default. For secrets
    // this is usually empty — the dev will populate it from 1Password.
    return { source: 'schema', value: item.value };
}

function isRenameSource(key: string): boolean {
    for (const oldNames of Object.values(RENAMES)) {
        if (oldNames.includes(key)) return true;
    }
    return false;
}

main();
