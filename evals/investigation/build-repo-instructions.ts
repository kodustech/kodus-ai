// Builds the RECALL_REPO_INSTRUCTIONS file: for every finder-recall case, the
// coding-agent instructions a review would read, collected by the production
// `collectRepoInstructions` from a blob-less clone of the case's upstream repo.
//
//   --at=base     each PR's base commit: what a review of that PR would read
//   --at=pinned   the commits in repo-instructions-pins.json, one per upstream
//                 (the all-50 on/off check of #1823 used these)
//   --output=<file>                     where to write it (required)
//   --clones=<dir>                      clone cache (default .tmp/recall-clones)
//
// Usage:
//   TS_NODE_PROJECT=tsconfig.json TS_NODE_TRANSPILE_ONLY=1 npx ts-node \
//     -r tsconfig-paths/register evals/investigation/build-repo-instructions.ts \
//     --at=base --output=.tmp/instructions-base.json
//   RECALL_REPO_INSTRUCTIONS=.tmp/instructions-base.json RECALL_ALL=1 \
//     node evals/investigation/run-recall.js --model=deepseek-v4-flash@fireworks
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { collectRepoInstructions } from '../../libs/code-review/infrastructure/agents/collaborators/repo-instructions';

const ROOT = path.resolve(__dirname, '../..');
const DATASETS = path.join(__dirname, 'datasets');
const PINS = path.join(__dirname, 'repo-instructions-pins.json');

// The benchmark mirrors point at their upstream; instructions come from there.
const UPSTREAM: Record<string, string> = {
    'keycloak/keycloak': 'keycloak/keycloak',
    'discourse/discourse': 'discourse/discourse',
    'calcom/cal.com': 'calcom/cal.com',
    'grafana/grafana': 'grafana/grafana',
    'getsentry/sentry': 'getsentry/sentry',
    'ai-code-review-evaluation/sentry-greptile': 'getsentry/sentry',
};

type CaseVars = {
    caseId?: string;
    repositoryFullName?: string;
    benchmarkBaseRef?: string;
    benchmarkHeadRef?: string;
    changedFiles?: string | Array<{ filename: string }>;
};

const arg = (name: string): string | undefined =>
    process.argv
        .find((a) => a.startsWith(`--${name}=`))
        ?.slice(name.length + 3);

const git = (dir: string, args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

function cloneFor(clones: string, upstream: string): string {
    const dir = path.join(clones, upstream.replace('/', '__'));
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        git(dir, ['init', '-q']);
        git(dir, ['remote', 'add', 'origin', `https://github.com/${upstream}.git`]);
        git(dir, ['config', 'remote.origin.promisor', 'true']);
        git(dir, ['config', 'remote.origin.partialclonefilter', 'blob:none']);
    }
    return dir;
}

function ensureCommit(dir: string, sha: string, depth = 1): void {
    try {
        git(dir, ['cat-file', '-e', `${sha}^{commit}`]);
        if (depth === 1) return;
    } catch {
        // not fetched yet
    }
    git(dir, ['fetch', '-q', '--filter=blob:none', `--depth=${depth}`, 'origin', sha]);
}

function loadCases(): CaseVars[] {
    return fs
        .readdirSync(DATASETS)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
            const raw = JSON.parse(fs.readFileSync(path.join(DATASETS, f), 'utf8'));
            return (Array.isArray(raw) ? raw[0] : raw)?.vars as CaseVars | undefined;
        })
        .filter((v): v is CaseVars => !!v?.caseId);
}

async function main(): Promise<number> {
    const at = arg('at') ?? 'base';
    const output = arg('output');
    const clones = path.resolve(ROOT, arg('clones') ?? '.tmp/recall-clones');
    if (!output || !['base', 'pinned'].includes(at)) {
        console.error('usage: build-repo-instructions.ts --at=base|pinned --output=<file> [--clones=<dir>]');
        return 2;
    }
    const pins: Record<string, string> =
        at === 'pinned' ? JSON.parse(fs.readFileSync(PINS, 'utf8')) : {};

    const out: Record<string, unknown> = {};
    for (const v of loadCases()) {
        const caseId = v.caseId as string;
        const upstream = UPSTREAM[v.repositoryFullName ?? ''];
        if (!upstream) {
            out[caseId] = { skipped: `no upstream for ${v.repositoryFullName}` };
            continue;
        }
        const dir = cloneFor(clones, upstream);

        let ref: string;
        try {
            if (at === 'pinned') {
                ref = pins[upstream];
                if (!ref) throw new Error(`no pin for ${upstream}`);
                ensureCommit(dir, ref);
            } else if (v.benchmarkBaseRef) {
                ref = v.benchmarkBaseRef;
                ensureCommit(dir, ref);
            } else if (v.benchmarkHeadRef) {
                ensureCommit(dir, v.benchmarkHeadRef, 2);
                ref = git(dir, ['rev-parse', `${v.benchmarkHeadRef}^`]).trim();
            } else {
                out[caseId] = { skipped: 'no base or head ref' };
                continue;
            }
        } catch (error) {
            out[caseId] = { skipped: `fetch failed: ${(error as Error).message.slice(0, 160)}` };
            console.log(`SKIP ${caseId}: fetch failed`);
            continue;
        }

        const changed = (
            typeof v.changedFiles === 'string'
                ? (JSON.parse(v.changedFiles) as Array<{ filename: string }>)
                : (v.changedFiles ?? [])
        ).map((f) => f.filename);

        const repoInstructions = await collectRepoInstructions({
            changedFiles: changed,
            listFiles: async () =>
                git(dir, ['ls-tree', '-r', '--name-only', ref]).split('\n').filter(Boolean),
            readFile: async (p) => {
                try {
                    return git(dir, ['show', `${ref}:${p}`]);
                } catch {
                    return null;
                }
            },
        });
        out[caseId] = { repo: upstream, ref, repoInstructions };
        console.log(
            `${repoInstructions.files.length ? 'HAS ' : 'none'} ${caseId} listed=${repoInstructions.files.map((f) => f.path).join(',')}`,
        );
    }

    fs.writeFileSync(path.resolve(ROOT, output), JSON.stringify(out, null, 2));
    console.log(`wrote ${output}`);
    return 0;
}

main().then(
    (code) => process.exit(code),
    (error) => {
        console.error(error instanceof Error ? error.stack : String(error));
        process.exit(1);
    },
);
