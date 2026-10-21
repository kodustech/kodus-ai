/**
 * Does the dependency scan actually find anything on real pull requests?
 *
 * Prevalence says 9.8% of human PRs touch a lockfile, and the structural
 * argument for keeping osv-scanner is that a database lookup is something the
 * reviewer cannot do. Neither is a measurement. If real lockfile changes rarely
 * introduce a flagged version then the tool finds nothing either, and the
 * argument is about an empty category.
 *
 * Runs the REAL DependencyScanTool — including its added-line anchoring, which
 * is what stops a lockfile's whole pre-existing tree being reported — against
 * the lockfiles of every lockfile-touching PR in the prevalence sample.
 *
 * Usage: npx tsx scripts/analyzer-prevalence/osv-yield.ts [--limit N]
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { DependencyScanTool } from '@libs/code-review/infrastructure/analyzers/tools/dependency-scan.tool';
import { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';
import { ChangedFile } from '@libs/code-review/infrastructure/analyzers/tool.contract';

const exec = promisify(execFile);
const arg = (n: string, d?: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i === -1 ? d : process.argv[i + 1];
};
const LIMIT = Number(arg('limit', '1000'));

function makeSandbox(repoDir: string): SandboxInstance {
    return {
        repoDir,
        type: 'local',
        sandboxId: 'osv-yield',
        remoteCommands: {} as never,
        cleanup: async () => undefined,
        run: async (command: string) => {
            try {
                const { stdout, stderr } = await exec(
                    'bash',
                    ['-lc', command],
                    {
                        maxBuffer: 128 * 1024 * 1024,
                    },
                );
                return { stdout, stderr, exitCode: 0 };
            } catch (e) {
                const err = e as {
                    stdout?: string;
                    stderr?: string;
                    code?: number;
                };
                return {
                    stdout: err.stdout ?? '',
                    stderr: err.stderr ?? '',
                    exitCode: typeof err.code === 'number' ? err.code : 1,
                };
            }
        },
        readFile: async (p: string) =>
            (await exec('cat', [p], { maxBuffer: 128 * 1024 * 1024 })).stdout,
        writeFile: async (p: string, c: string) => {
            await mkdir(dirname(p), { recursive: true });
            await writeFile(p, c, 'utf8');
        },
    } as SandboxInstance;
}

const gh = async (args: string[]) =>
    (await exec('gh', args, { maxBuffer: 64 * 1024 * 1024 })).stdout;

async function main() {
    const rows = JSON.parse(
        readFileSync('scripts/analyzer-prevalence/result.json', 'utf8'),
    )
        .rows.filter(
            (r: any) =>
                !r.skipped &&
                !r.fork &&
                !r.archived &&
                r.fired.includes('dependencies'),
        )
        .slice(0, LIMIT);

    const tool = new DependencyScanTool();
    const out: any[] = [];
    process.stderr.write(`scanning ${rows.length} lockfile PRs\n`);

    for (const [i, pr] of rows.entries()) {
        let files: Array<{ filename: string; patch?: string }>;
        let sha: string;
        try {
            sha = (
                await gh([
                    'api',
                    `repos/${pr.repo}/pulls/${pr.number}`,
                    '--jq',
                    '.head.sha',
                ])
            ).trim();
            files = JSON.parse(
                await gh([
                    'api',
                    `repos/${pr.repo}/pulls/${pr.number}/files?per_page=100`,
                    '--jq',
                    '[.[] | select(.patch != null) | {filename, patch}]',
                ]),
            );
        } catch {
            continue;
        }

        const claimed = tool.selectFiles(files as ChangedFile[]);
        if (!claimed.length) continue;

        const dir = await mkdtemp(join(tmpdir(), 'osv-'));
        try {
            let wrote = 0;
            for (const f of claimed) {
                try {
                    // Raw beats `--jq .content`: a multi-megabyte lockfile as
                    // base64 through jq is where this spent all its time.
                    const content = await gh([
                        'api',
                        `repos/${pr.repo}/contents/${encodeURI(f.filename)}?ref=${sha}`,
                        '-H',
                        'Accept: application/vnd.github.raw',
                    ]);
                    const abs = join(dir, f.filename);
                    await mkdir(dirname(abs), { recursive: true });
                    await writeFile(abs, content, 'utf8');
                    wrote++;
                } catch {
                    /* too large or gone */
                }
            }
            if (!wrote) continue;

            let findings: any[] = [];
            try {
                findings = await tool.run({
                    sandbox: makeSandbox(dir),
                    files: claimed,
                });
            } catch (e) {
                out.push({
                    pr: `${pr.repo}#${pr.number}`,
                    bot: pr.bot,
                    error: String((e as Error).message).slice(0, 80),
                });
                process.stderr.write('x');
                continue;
            }

            out.push({
                pr: `${pr.repo}#${pr.number}`,
                bot: pr.bot,
                lockfiles: claimed.length,
                findings: findings.length,
                advisories: [...new Set(findings.map((f) => f.ruleId))].slice(
                    0,
                    6,
                ),
                severities: findings.map((f) => f.severity),
            });
            process.stderr.write(findings.length ? '+' : '.');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
        if (i % 25 === 0) process.stderr.write(` ${i} `);
    }

    const ok = out.filter((r) => !r.error);
    const withFindings = ok.filter((r) => r.findings > 0);
    const human = ok.filter((r) => !r.bot);
    const bot = ok.filter((r) => r.bot);
    const pct = (a: number, b: number) =>
        b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a';

    console.log(`\n\n=== dependency scan yield on real lockfile PRs ===`);
    console.log(
        `scanned ${ok.length} PRs (${out.length - ok.length} errored)\n`,
    );
    console.log(
        `PRs with >=1 in-diff finding : ${withFindings.length}/${ok.length}  (${pct(withFindings.length, ok.length)})`,
    );
    console.log(
        `  human-authored             : ${human.filter((r) => r.findings > 0).length}/${human.length}  (${pct(human.filter((r) => r.findings > 0).length, human.length)})`,
    );
    console.log(
        `  bot-authored               : ${bot.filter((r) => r.findings > 0).length}/${bot.length}  (${pct(bot.filter((r) => r.findings > 0).length, bot.length)})`,
    );
    console.log(
        `total findings               : ${ok.reduce((a, r) => a + r.findings, 0)}`,
    );
    const sev: Record<string, number> = {};
    for (const r of ok)
        for (const s of r.severities ?? []) sev[s] = (sev[s] ?? 0) + 1;
    console.log(`by severity                  : ${JSON.stringify(sev)}`);

    if (withFindings.length) {
        console.log('\nexamples:');
        for (const r of withFindings.slice(0, 10)) {
            console.log(
                `  ${r.pr}${r.bot ? ' [bot]' : ''}  ${r.findings} finding(s)  ${r.advisories.join(', ')}`,
            );
        }
    }
    writeFileSync(
        'scripts/analyzer-prevalence/osv-yield.json',
        JSON.stringify(out, null, 2),
    );
    console.log(`\nper-PR: scripts/analyzer-prevalence/osv-yield.json`);
}

void main();
