/**
 * CI gate — catches env vars consumed in code that are NOT declared in
 * .env.schema. Complements check-drift.ts (which catches the inverse:
 * generated outputs out of sync with the schema).
 *
 * How it works:
 *   1. greps the codebase for `process.env.X` and `env.X` usages
 *   2. filters to "Kodus-shaped" prefixes (drops Node stdlib + tooling)
 *   3. applies an allowlist for known false-positives (CLI app, tests,
 *      DI tokens that grep can't tell from real env vars)
 *   4. compares against vars declared in .env.schema
 *   5. exits non-zero with a clear message if anything's missing
 *
 * Run locally: pnpm run env:check:coverage
 * In CI: env-drift-check.yml runs this after the drift check.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { flatten, parseSchema } from './parse-schema';

const REPO_ROOT = join(__dirname, '..', '..');

// Vars whose names start with one of these prefixes are considered
// "Kodus-shaped" and therefore candidates to be in the schema. Anything
// else from the grep (NODE_ENV, PATH, JEST_WORKER_ID, etc) is ignored.
const KODUS_PREFIX_RE =
    /^(API_|WEB_|KODUS_|GLOBAL_|GITHUB_|GITLAB_|BITBUCKET_|AZURE_|FORGEJO_|RABBIT|WORKFLOW_|AST_|ANALYTICS_|MCP_|METRICS_|REVIEW_|WEBHOOK_|MONGODB_|DATABASE_|SANDBOX_|LANGFUSE_|PYROSCOPE_|RESEND_|N8N_|CODE_MANAGEMENT_|NEXTAUTH_|RUN_)/;

// Names that match these patterns are deliberately NOT in the schema.
// Grouped by reason so the gate's failure message can point reviewers at
// the right next step.
const ALLOWLIST: Array<{ pattern: RegExp; reason: string }> = [
    {
        // apps/cli is a standalone CLI tool with its own config story —
        // not part of the api/worker/web/webhooks/mcp-manager runtime.
        // KODUS_LICENSE_KEY is the one exception (real EE feature flag).
        pattern: /^KODUS_(?!LICENSE_KEY$)/,
        reason: 'apps/cli (standalone CLI tool, not the main runtime)',
    },
    {
        // *_TEST_* vars are read by scripts/dev/test-emails.ts and similar
        // local test helpers, not by the runtime.
        pattern: /_TEST_/,
        reason: 'test/dev fixtures (local-only helpers)',
    },
    {
        // Generic names captured by the grep that are almost certainly
        // DI tokens or test identifiers, not env vars.
        pattern: /^(API_KEY|API_KEY_SECRET|API_KEY_SECRET_PEPPER|API_SECRET_KEY|RUN_NAME)$/,
        reason: 'generic name — likely DI token or test fixture (false positive)',
    },
    {
        // Inherited from the original kodus-mcp-manager imports — those
        // module names also use SCREAMING_CASE strings the grep mistakes
        // for env vars.
        pattern: /^(BEARER_TOKEN|GOOGLE_SERVICE_ACCOUNT|NO_AUTH|BASIC_WITH_JWT)$/,
        reason: 'enum/string-literal in mcp-manager (false positive)',
    },
    {
        // GitHub Actions runtime variables referenced by inline `node`
        // scripts in .github/workflows/*.yml (the scan includes *.yml).
        // Injected by the Actions runner — CI plumbing, never Kodus
        // runtime config, so they don't belong in .env.schema.
        pattern: /^(GITHUB_OUTPUT|GITHUB_ENV|GITHUB_STATE|GITHUB_STEP_SUMMARY|GITHUB_PATH|RUNNER_TEMP)$/,
        reason: 'GitHub Actions workflow plumbing (inline node in *.yml), not a Kodus env var',
    },
];

function grepStrongUsages(): Set<string> {
    // Only "strong" patterns — process.env.X and env.X destructured —
    // not bare quoted SCREAMING_CASE strings (too noisy for a CI gate).
    const patterns = [
        String.raw`process\.env\.([A-Z][A-Z0-9_]+)`,
        String.raw`\benv\.([A-Z][A-Z0-9_]+)`,
    ];
    const args = [
        '-rohE',
        '--exclude-dir=node_modules',
        '--exclude-dir=dist',
        '--exclude-dir=build',
        '--exclude-dir=.next',
        '--exclude-dir=.cache',
        '--exclude-dir=.git',
        '--exclude-dir=.env-preview',
        // Nested git worktrees (e.g. .worktrees/worker-prodlike-sim) are
        // separate checkouts — often carrying their own dist/ bundles and EE
        // libs — not the main tree's source of truth. Scanning them surfaces
        // env vars that only exist on that other branch (false positives).
        // Exclude like node_modules/dist.
        '--exclude-dir=.worktrees',
        // Claude Code / Cursor / IDE local config — sometimes contains
        // example commands with `process.env.X` in escaped JSON. Not code.
        '--exclude-dir=.claude',
        '--exclude-dir=.cursor',
        '--exclude-dir=.vscode',
        // Nested git worktrees (Claude Code / manual `git worktree`) hold
        // checkouts of OTHER branches — older code using since-renamed env
        // names (e.g. API_OPENROUTER_KEY → API_OPEN_ROUTER_API_KEY,
        // API_SERVICE_AST_URL, API_SENTRY_DNS). Scanning them flags phantom
        // vars that don't exist in THIS branch's tracked code.
        '--exclude-dir=.worktrees',
        '--exclude-dir=worktrees',
        // Tooling that's NOT part of the runtime — has its own config story
        // and shouldn't gate the schema. Promotion/cross-file/safeguard
        // evals reference legacy env names that were renamed in production
        // code (e.g. API_OPENROUTER_KEY → API_OPEN_ROUTER_API_KEY).
        '--exclude-dir=evals',
        // Standalone CLI app — already covered by the KODUS_* allowlist
        // pattern below, but excluding here too saves a few seconds.
        '--exclude-dir=apps/cli',
        // E2E test harness with its own CLI under tests/e2e/cli. Reads
        // local config (e.g. API_LLM_PROVIDER for BYOK seed) that's
        // never consumed by api/web/worker runtime — same shape as
        // apps/cli, just lives under tests/ instead of apps/.
        '--exclude-dir=tests',
        // Schema/scripts/CI tooling itself references env var names as
        // strings (e.g. SECRET_RE in build-slim-csv.ts, KODUS_PREFIX_RE
        // here). Don't double-count those.
        '--exclude-dir=scripts/env',
        '--include=*.ts',
        '--include=*.tsx',
        '--include=*.js',
        '--include=*.json',
        '--include=*.yml',
        '--include=*.yaml',
        '--include=*.sh',
    ];
    const found = new Set<string>();
    for (const p of patterns) {
        const r = spawnSync('grep', [...args, p, '.'], {
            cwd: REPO_ROOT,
            encoding: 'utf-8',
            maxBuffer: 128 * 1024 * 1024,
        });
        for (const line of (r.stdout || '').split('\n')) {
            const m = line.match(/([A-Z][A-Z0-9_]+)/);
            if (m) found.add(m[1]);
        }
    }
    return found;
}

function isAllowed(name: string): { allowed: boolean; reason?: string } {
    for (const { pattern, reason } of ALLOWLIST) {
        if (pattern.test(name)) return { allowed: true, reason };
    }
    return { allowed: false };
}

function main() {
    const schemaItems = flatten(parseSchema(join(REPO_ROOT, '.env.schema')));
    const declared = new Set(schemaItems.map((it) => it.name));

    const used = grepStrongUsages();

    const undeclared: string[] = [];
    const allowedHits: Map<string, string[]> = new Map();
    for (const name of used) {
        if (!KODUS_PREFIX_RE.test(name)) continue; // not Kodus-shaped
        if (declared.has(name)) continue; // already in schema, OK
        const { allowed, reason } = isAllowed(name);
        if (allowed && reason) {
            const list = allowedHits.get(reason) ?? [];
            list.push(name);
            allowedHits.set(reason, list);
        } else {
            undeclared.push(name);
        }
    }

    console.log(`Schema declares: ${declared.size} vars`);
    console.log(`Code references: ${[...used].filter((n) => KODUS_PREFIX_RE.test(n)).length} Kodus-shaped vars`);
    console.log(`Allowlisted:     ${[...allowedHits.values()].reduce((a, l) => a + l.length, 0)}`);
    console.log();

    if (allowedHits.size > 0) {
        console.log('Allowlisted (deliberately not in schema):');
        for (const [reason, names] of allowedHits.entries()) {
            console.log(`  • ${reason} — ${names.length} var(s)`);
            for (const n of names.slice(0, 5))
                console.log(`      ${n}`);
            if (names.length > 5)
                console.log(`      … and ${names.length - 5} more`);
        }
        console.log();
    }

    if (undeclared.length === 0) {
        console.log('✓ All code-referenced env vars are declared in .env.schema.');
        return;
    }

    console.error(
        `✗ ${undeclared.length} env var(s) used in code but missing from .env.schema:`,
    );
    for (const n of undeclared.sort()) console.error(`    ${n}`);
    console.error();
    console.error('Add each one to .env.schema with the right audience and');
    console.error('a short description, then re-run pnpm run env:apply. If a var');
    console.error("really shouldn't be in the schema (CLI-only, test fixture,");
    console.error('false positive), add it to ALLOWLIST in scripts/env/check-coverage.ts.');
    process.exit(1);
}

main();
