/**
 * How often does each deterministic analyzer apply to a real pull request?
 *
 * This measures PREVALENCE, not capability. It runs each tool's real
 * `selectFiles` over a uniform sample of merged public PRs and counts how often
 * the tool would fire at all. No analyzer executes, no model is called, and no
 * ground truth is needed — only filenames and patches.
 *
 * It exists because capability is worthless without it. The rule pack detects
 * real vulnerabilities and the reviewer already catches every one it finds; the
 * remaining case for the conditional analyzers rests on how often the file
 * types they cover actually show up. On the 50-PR review benchmark five of ten
 * tools never fired once, but that corpus is two repositories of application
 * code and cannot settle the question.
 *
 * Usage:
 *   node scripts/analyzer-prevalence/sample-prs.mjs sample.json --hours 8 --sample 1000
 *   npx tsx scripts/analyzer-prevalence/measure.ts sample.json --out result.json
 */
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

import { SecretScanTool } from '@libs/code-review/infrastructure/analyzers/tools/secret-scan.tool';
import { DependencyScanTool } from '@libs/code-review/infrastructure/analyzers/tools/dependency-scan.tool';
import { ChangedFile } from '@libs/code-review/infrastructure/analyzers/tool.contract';

const exec = promisify(execFile);

const arg = (n: string, d?: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i === -1 ? d : process.argv[i + 1];
};

const SAMPLE_FILE = process.argv[2];
const OUT = arg('out', 'scripts/analyzer-prevalence/result.json')!;
const CONCURRENCY = Number(arg('concurrency', '6'));

const TOOLS = [new SecretScanTool(), new DependencyScanTool()];

/** Authored by automation. Reported separately: bots are overwhelmingly
 *  lockfile bumps, and blending them makes the dependency number meaningless. */
const BOT = /\[bot\]$|^dependabot|^renovate|^greenkeeper|^snyk-bot|^imgbot|^allcontributors/i;

type Row = {
    repo: string; number: number;
    bot: boolean; stars: number; language: string | null;
    fork: boolean; archived: boolean;
    files: number; truncated: boolean;
    fired: string[];
    skipped?: string;
};

async function gh(path: string): Promise<unknown> {
    const { stdout } = await exec('gh', ['api', path], { maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout);
}

async function one(pr: { repo: string; number: number }): Promise<Row | null> {
    const base: Row = {
        repo: pr.repo, number: pr.number, bot: false, stars: 0,
        language: null, fork: false, archived: false,
        files: 0, truncated: false, fired: [],
    };

    let meta: any;
    try {
        meta = await gh(`repos/${pr.repo}/pulls/${pr.number}`);
    } catch {
        // Deleted, private, or the repo went away between archive and now.
        return null;
    }

    base.bot = meta.user?.type === 'Bot' || BOT.test(meta.user?.login ?? '');
    base.stars = meta.base?.repo?.stargazers_count ?? 0;
    base.language = meta.base?.repo?.language ?? null;
    base.fork = Boolean(meta.base?.repo?.fork);
    base.archived = Boolean(meta.base?.repo?.archived);

    const changed = meta.changed_files ?? 0;
    if (changed === 0) {
        base.skipped = 'no files';
        return base;
    }

    let files: Array<{ filename: string; patch?: string }>;
    try {
        files = (await gh(
            `repos/${pr.repo}/pulls/${pr.number}/files?per_page=100`,
        )) as Array<{ filename: string; patch?: string }>;
    } catch {
        base.skipped = 'files unavailable';
        return base;
    }

    base.files = files.length;
    base.truncated = changed > files.length;

    for (const tool of TOOLS) {
        if (tool.selectFiles(files as ChangedFile[]).length > 0) {
            base.fired.push(tool.id);
        }
    }
    return base;
}

async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>) {
    const out: R[] = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) {
            const k = i++;
            out[k] = await fn(items[k], k);
            if (k % 25 === 0) process.stderr.write(`${k} `);
        }
    }));
    return out;
}

const pct = (a: number, b: number) => (b === 0 ? '  n/a' : `${((a / b) * 100).toFixed(1)}%`);

function report(rows: Row[], label: string) {
    const n = rows.length;
    if (n === 0) { console.log(`\n${label}: no PRs`); return; }
    console.log(`\n=== ${label} (n=${n}) ===`);
    console.log('tool              fires on');
    for (const t of TOOLS) {
        const hit = rows.filter((r) => r.fired.includes(t.id)).length;
        console.log(`  ${t.id.padEnd(16)} ${String(hit).padStart(5)}  ${pct(hit, n).padStart(6)}`);
    }
    const conditional = ['dependencies'];
    const anyCond = rows.filter((r) => r.fired.some((f) => conditional.includes(f))).length;
    console.log(`  ${'— any conditional'.padEnd(16)} ${String(anyCond).padStart(5)}  ${pct(anyCond, n).padStart(6)}`);
}

async function main() {
    const sample = JSON.parse(readFileSync(SAMPLE_FILE, 'utf8'));
    const prs: Array<{ repo: string; number: number }> = sample.prs;
    process.stderr.write(`resolving ${prs.length} PRs\n`);

    const rows = (await pool(prs, CONCURRENCY, one)).filter(Boolean) as Row[];
    const usable = rows.filter((r) => !r.skipped && !r.fork && !r.archived);

    console.log(`\nsampled ${prs.length}  resolved ${rows.length}  usable ${usable.length}`);
    console.log(`(dropped: ${rows.length - usable.length} fork/archived/empty; ${prs.length - rows.length} unreachable)`);
    console.log(`truncated file lists (>100 files): ${usable.filter((r) => r.truncated).length}`);

    report(usable, 'ALL usable PRs');
    report(usable.filter((r) => !r.bot), 'human-authored');
    report(usable.filter((r) => r.bot), 'bot-authored');

    // Stars is a popularity proxy and popularity correlates with the CI hygiene
    // being measured, so it is reported as a sensitivity band, never as a filter.
    console.log('\n=== sensitivity to repository popularity (human-authored) ===');
    for (const floor of [0, 10, 100, 1000]) {
        const sub = usable.filter((r) => !r.bot && r.stars >= floor);
        const cond = ['dependencies'];
        const hit = sub.filter((r) => r.fired.some((f) => cond.includes(f))).length;
        console.log(`  stars >= ${String(floor).padEnd(5)} n=${String(sub.length).padStart(5)}  any conditional: ${pct(hit, sub.length)}`);
    }

    writeFileSync(OUT, JSON.stringify({ sample: SAMPLE_FILE, generatedAt: new Date().toISOString(), rows }, null, 2));
    console.log(`\nper-PR rows: ${OUT}`);
}

void main();
