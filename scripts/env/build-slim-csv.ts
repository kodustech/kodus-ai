/**
 * Generates .env-preview/review.csv — a slim CSV for spreadsheet review.
 *
 * 7 columns. One decision per row. Pre-filled with my best guess.
 * You only TYPE when you disagree (in the "your_decision" column).
 *
 * Open with: `open .env-preview/review.csv` (Numbers / Excel / Sheets).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { flatten, parseSchema, SchemaItem } from './parse-schema';

const REPO_ROOT = join(__dirname, '..', '..');
const OUT = join(REPO_ROOT, '.env-preview', 'review.csv');

const SECRET_RE = /(KEY|SECRET|PASSWORD|TOKEN|DSN|CREDENTIAL|PASS$)/;
const PORT_RE = /_PORT$/;
const URL_RE = /_URL$|_URI$|_WEBHOOK$/;
const CRON_RE = /^API_CRON_/;
const BOOL_RE = /^(ENABLE|USE|DISABLE)_|_ENABLED$|_DISABLED$|_TRACING$/;

type Source = {
    main: Set<string>;
    installer: Set<string>;
    local: Set<string>;
    used: Set<string>;        // any reference (high recall)
    usedStrong: Set<string>;  // process.env.X / env.X only (high precision)
    schema: Map<string, SchemaItem>;
};

function parseEnv(path: string): Set<string> {
    if (!existsSync(path)) return new Set();
    const out = new Set<string>();
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z][A-Z0-9_]*)=/);
        if (m) out.add(m[1]);
    }
    return out;
}

function parseEnvWithValues(path: string): Map<string, string> {
    const out = new Map<string, string>();
    if (!existsSync(path)) return out;
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
        if (!m) continue;
        let v = m[2];
        // Quoted value: strip the wrapping quotes and discard everything after.
        const quoted = v.match(/^\s*(['"])(.*?)\1/);
        if (quoted) {
            v = quoted[2];
        } else {
            // Unquoted: strip inline comment, then trim.
            v = v.replace(/\s+#.*$/, '').trim();
        }
        out.set(m[1], v);
    }
    return out;
}

type Usage = { all: Set<string>; strong: Set<string> };

function grepUsage(): Usage {
    // Strong patterns: certainly an env var read.
    const strongPatterns = [
        String.raw`process\.env\.([A-Z][A-Z0-9_]+)`,
        String.raw`\benv\.([A-Z][A-Z0-9_]+)`,
    ];
    // Weak pattern: any quoted SCREAMING_CASE string. Catches
    // ConfigService.get('X'), Joi schemas — but also DI tokens and enums.
    const weakPatterns = [String.raw`['"]([A-Z][A-Z0-9_]{4,})['"]`];
    const patterns = [...strongPatterns, ...weakPatterns];
    const args = [
        '-rohE',
        '--exclude-dir=node_modules',
        '--exclude-dir=dist',
        '--exclude-dir=build',
        '--exclude-dir=.next',
        '--exclude-dir=.cache',
        '--exclude-dir=.git',
        '--exclude-dir=.env-preview',
        '--include=*.ts',
        '--include=*.tsx',
        '--include=*.js',
        '--include=*.json',
        '--include=*.yml',
        '--include=*.yaml',
        '--include=*.sh',
    ];
    const all = new Set<string>();
    const strong = new Set<string>();
    for (const p of patterns) {
        const r = spawnSync('grep', [...args, p, '.'], {
            cwd: REPO_ROOT,
            encoding: 'utf-8',
            maxBuffer: 128 * 1024 * 1024,
        });
        const isStrong = strongPatterns.includes(p);
        for (const line of (r.stdout || '').split('\n')) {
            const m = line.match(/([A-Z][A-Z0-9_]+)/);
            if (m) {
                all.add(m[1]);
                if (isStrong) strong.add(m[1]);
            }
        }
    }
    return { all, strong };
}

function inferCategory(name: string, sch: SchemaItem | undefined): string {
    if (sch) return sch.category;
    if (/^ANALYTICS_|_ANALYTICS_/.test(name)) return 'analytics-warehouse';
    if (/^API_MCP_MANAGER_/.test(name)) return 'mcp-manager';
    if (/^AST_|_AST_/.test(name)) return 'ast-service';
    if (/^RABBIT|^WORKFLOW_/.test(name)) return 'messaging';
    if (/^API_CRON_/.test(name)) return 'cron';
    if (/BETTERSTACK|^METRICS_|^WEBHOOK_FAILURE|POSTHOG|LANGFUSE|SENTRY|PYROSCOPE/.test(name))
        return 'observability';
    if (/^API_DOCS_/.test(name)) return 'api-docs';
    if (/^WEB_/.test(name)) return 'web';
    if (/GITHUB|GITLAB|BITBUCKET|AZURE|FORGEJO/.test(name)) return 'git-providers';
    if (/OPENAI|ANTHROPIC|GEMINI|GOOGLE_AI|VERTEX|GROQ|NOVITA|CEREBRAS|OPENROUTER|MORPHLLM|LLM/.test(name))
        return 'llm';
    if (/PG_DB|MG_DB|DATABASE|MONGODB/.test(name)) return 'database';
    if (/JWT|CRYPTO|NEXTAUTH/.test(name)) return 'auth';
    if (/AWS|S3/.test(name)) return 'storage';
    if (/RESEND|EMAIL/.test(name)) return 'email';
    if (/SANDBOX|E2B/.test(name)) return 'sandbox';
    return 'misc';
}

function inferProposal(name: string, src: Source): string {
    const sch = src.schema.get(name);
    if (sch) {
        if (sch.audience.includes('self-hosted-enterprise'))
            return 'self-hosted-enterprise';
        if (sch.audience.includes('cloud') && !sch.audience.includes('both'))
            return 'cloud';
        if (sch.audience.includes('self-hosted') && !sch.audience.includes('both'))
            return 'self-host';
        return sch.installerComment ? 'both/opt-in' : 'both/active';
    }
    // Code-only: var is consumed but never templated → caller must classify.
    if (src.used.has(name) && !src.main.has(name) && !src.installer.has(name))
        return '??';
    if (src.main.has(name) && !src.used.has(name) && !src.installer.has(name))
        return 'dead';
    if (src.main.has(name) || src.used.has(name)) return 'both/active';
    if (src.installer.has(name)) return 'self-host';
    return 'dead';
}

function presence(name: string, src: Source): string {
    const p: string[] = [];
    if (src.main.has(name)) p.push('main');
    if (src.installer.has(name)) p.push('inst');
    if (src.local.has(name)) p.push('local');
    if (src.used.has(name) && p.length === 0) p.push('code-only');
    return p.join('+') || '—';
}

function hints(name: string, src: Source): string[] {
    const h: string[] = [];
    if (SECRET_RE.test(name)) h.push('secret');
    if (PORT_RE.test(name)) h.push('port');
    if (URL_RE.test(name)) h.push('url');
    if (CRON_RE.test(name)) h.push('cron');
    if (BOOL_RE.test(name)) h.push('bool');
    if (!src.used.has(name)) h.push('NOT-IN-CODE');
    return h;
}

function csvEscape(s: string): string {
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

function main() {
    const schemaItems = flatten(parseSchema(join(REPO_ROOT, '.env.schema')));
    const schema = new Map<string, SchemaItem>();
    for (const it of schemaItems) schema.set(it.name, it);

    const usage = grepUsage();
    const mainValues = parseEnvWithValues(join(REPO_ROOT, '.env.example'));
    const installerValues = parseEnvWithValues(
        join(REPO_ROOT, '..', 'kodus-installer', '.env.example'),
    );
    const src: Source = {
        main: new Set(mainValues.keys()),
        installer: new Set(installerValues.keys()),
        local: parseEnv(join(REPO_ROOT, '.env')),
        used: usage.all,
        usedStrong: usage.strong,
        schema,
    };

    // Include code-only vars that look "Kodus-shaped" — drops Node stdlib
    // and tooling vars (PATH, HOME, JEST_WORKER_ID, etc).
    const KODUS_PREFIX_RE =
        /^(API_|WEB_|KODUS_|GLOBAL_|GITHUB_|GITLAB_|BITBUCKET_|AZURE_|FORGEJO_|RABBIT|WORKFLOW_|AST_|ANALYTICS_|MCP_|METRICS_|REVIEW_|WEBHOOK_|MONGODB_|DATABASE_|SANDBOX_|LANGFUSE_|PYROSCOPE_|RESEND_|N8N_|CODE_MANAGEMENT_|NEXTAUTH_|RUN_)/;
    // High-precision orphan detection: only count code-only vars accessed
    // via process.env.X or env.X — drops DI tokens, enums, log keys.
    const codeOnlyOrphans = new Set(
        [...src.usedStrong].filter(
            (n) =>
                KODUS_PREFIX_RE.test(n) &&
                !n.endsWith('_') &&
                n.length >= 6 &&
                !src.main.has(n) &&
                !src.installer.has(n) &&
                !src.local.has(n) &&
                !src.schema.has(n),
        ),
    );

    const all = new Set<string>([
        ...src.main,
        ...src.installer,
        ...src.local,
        ...src.schema.keys(),
        ...codeOnlyOrphans,
    ]);

    const SECRET_HIDE = '••• (set)';
    type Row = {
        category: string;
        name: string;
        presence: string;
        hints: string;
        description: string;
        mainValue: string;
        installerValue: string;
        proposal: string;
    };
    const rows: Row[] = [];
    for (const name of all) {
        const sch = src.schema.get(name);
        const isSecret = SECRET_RE.test(name) || sch?.sensitive === true;
        const mv = mainValues.get(name) ?? '';
        const iv = installerValues.get(name) ?? sch?.installerDefault ?? '';
        rows.push({
            category: inferCategory(name, sch),
            name,
            presence: presence(name, src),
            hints: hints(name, src).join('; '),
            description: (sch?.description ?? []).join(' ').slice(0, 100),
            mainValue: isSecret && mv ? SECRET_HIDE : mv,
            // Show installer value only when it DIFFERS from main (the case that matters).
            installerValue:
                iv && iv !== mv
                    ? isSecret && iv
                        ? SECRET_HIDE
                        : iv
                    : '',
            proposal: inferProposal(name, src),
        });
    }

    // Sort by category then name.
    const catOrder = [
        'basic', 'server', 'auth', 'database', 'messaging', 'messaging-tuning',
        'llm', 'git-providers', 'observability',
        'analytics-warehouse', 'mcp-manager', 'ast-service',
        'sandbox', 'storage', 'email', 'cron', 'api-docs',
        'web', 'support', 'misc',
    ];
    rows.sort((a, b) => {
        const ia = catOrder.indexOf(a.category);
        const ib = catOrder.indexOf(b.category);
        const ra = ia === -1 ? 999 : ia;
        const rb = ib === -1 ? 999 : ib;
        return ra - rb || a.name.localeCompare(b.name);
    });

    const headers = [
        'category',
        'var_name',
        'presence',
        'hints',
        'description',
        'main_value',          // current value in kodus-ai/.env.example
        'installer_value',     // pre-filled when it DIFFERS from main; edit if you want override
        'proposal_mine',
        'your_override',       // EDIT HERE if you disagree with proposal
    ];

    const lines: string[] = [headers.map(csvEscape).join(',')];
    for (const r of rows) {
        lines.push([
            r.category, r.name, r.presence, r.hints, r.description,
            r.mainValue, r.installerValue,
            r.proposal, '',
        ].map(csvEscape).join(','));
    }

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, lines.join('\n') + '\n');

    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.proposal, (counts.get(r.proposal) ?? 0) + 1);

    console.log(`Wrote ${rows.length} vars to ${OUT}`);
    console.log('');
    console.log('Proposal distribution (pre-filled — override only if you disagree):');
    for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${k.padEnd(14)} ${v}`);
    }
}

main();
