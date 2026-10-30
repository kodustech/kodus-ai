import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    distillBranch,
    decisionId,
    parseJsonObject,
    readCachedSummary,
} from '../distill.service.js';
import {
    readAllBranchRecords,
    readBranchRecord,
    recordPathForBranch,
    configureTraceRefspec,
    pushTraceBranch,
    TRACE_BRANCH,
    TRACE_REF,
    writeBranchRecord,
} from '../decision-branch.service.js';
import { readAllLocalBranchRecords } from '../local-decisions.js';
import { readIncidents } from '../incidents.js';
import { appendRecordLine } from '../session-store.js';
import { recallDecisions } from '../recall.service.js';
import { updateSharedDecisionCorrection } from '../shared-corrections.js';

const GIT_ENV = {
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@test.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@test.invalid',
};

let traceHome: string;
let originDir: string;
let repoRoot: string;

async function git(cwd: string, args: string[]): Promise<string> {
    const result = await execa('git', args, { cwd, env: GIT_ENV });
    return result.stdout;
}

async function commitFile(
    cwd: string,
    filePath: string,
    content: string,
    message: string,
): Promise<void> {
    const absolute = path.join(cwd, filePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf-8');
    await git(cwd, ['add', filePath]);
    await git(cwd, ['commit', '-m', message]);
}

/**
 * A stub agent CLI. Returns commit summaries for the per-commit stage and a
 * decision set for the aggregate stage, and counts how often it is called so
 * the caching claim can be checked.
 */
function makeAgent(decisions: unknown[] = []): {
    run: (prompt: string) => Promise<string>;
    calls: string[];
} {
    const calls: string[] = [];
    return {
        calls,
        run: async (prompt: string) => {
            calls.push(prompt);
            if (prompt.startsWith('Summarize one commit')) {
                return JSON.stringify({
                    summary: 'a commit',
                    points: ['did a thing'],
                });
            }
            return `Sure! Here you go:\n\`\`\`json\n${JSON.stringify({
                decisions,
            })}\n\`\`\``;
        },
    };
}

beforeEach(async () => {
    traceHome = await fs.mkdtemp(path.join(os.tmpdir(), 'distill-home-'));
    process.env.KODUS_TRACE_HOME = traceHome;

    originDir = await fs.mkdtemp(path.join(os.tmpdir(), 'distill-origin-'));
    await git(originDir, ['init', '--bare', '--initial-branch=main']);

    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'distill-repo-'));
    await git(repoRoot, ['init', '--initial-branch=main']);
    await git(repoRoot, ['remote', 'add', 'origin', originDir]);
    await commitFile(repoRoot, 'README.md', '# repo\n', 'initial');
    await git(repoRoot, ['push', '-q', 'origin', 'main']);
    await git(repoRoot, ['checkout', '-q', '-b', 'feat/billing']);
});

afterEach(async () => {
    delete process.env.KODUS_TRACE_HOME;
    await Promise.all(
        [traceHome, originDir, repoRoot].map((dir) =>
            fs.rm(dir, { recursive: true, force: true }),
        ),
    );
});

const BILLING_DECISIONS = [
    {
        type: 'architectural_decision',
        origin: 'human',
        decision: 'Invoice totals are computed once and cached on the row',
        rationale: 'Recomputing on read made the list view quadratic',
        confidence: 0.9,
        evidence: ['src/billing/invoice.ts'],
        scope: ['src/billing'],
    },
];

describe('distillBranch', () => {
    it('keeps decision ids stable for the documented branch/text/scope tuple', () => {
        expect(
            decisionId('feat/billing', 'cache totals', [
                'src/billing',
                'src/shared',
            ]),
        ).toBe(
            decisionId('feat/billing', 'cache totals', [
                'src/shared',
                'src/billing',
            ]),
        );
    });

    it('produces one deduplicated decision set for the whole range', async () => {
        await commitFile(repoRoot, 'src/billing/invoice.ts', 'a\n', 'feat: a');
        await commitFile(repoRoot, 'src/billing/invoice.ts', 'b\n', 'feat: b');
        await commitFile(repoRoot, 'src/billing/total.ts', 'c\n', 'feat: c');

        const agent = makeAgent([
            ...BILLING_DECISIONS,
            // The model repeating itself must not produce two records.
            ...BILLING_DECISIONS,
        ]);

        const result = await distillBranch(repoRoot, {
            branch: 'feat/billing',
            defaultBranch: 'main',
            runAgent: agent.run,
        });

        expect(result.record.commits).toHaveLength(3);
        expect(result.record.decisions).toHaveLength(1);
        expect(result.record.decisions[0].scope).toEqual(['src/billing']);
        expect(result.record.decisions[0].type).toBe('architectural_decision');
        expect(result.record.decisions[0].autoPromoteCandidate).toBe(true);
    });

    it('drops scope paths the branch never touched', async () => {
        await commitFile(repoRoot, 'src/billing/invoice.ts', 'a\n', 'feat: a');

        const agent = makeAgent([
            {
                type: 'convention',
                decision: 'something about a file that does not exist',
                confidence: 0.8,
                scope: ['src/imaginary/module.ts', 'src/billing'],
            },
        ]);

        const result = await distillBranch(repoRoot, {
            branch: 'feat/billing',
            defaultBranch: 'main',
            runAgent: agent.run,
        });

        expect(result.record.decisions[0].scope).toEqual(['src/billing']);
    });

    it('replaces the branch record instead of appending: three pushes, one record', async () => {
        await commitFile(repoRoot, 'src/billing/invoice.ts', 'a\n', 'feat: a');

        for (let run = 0; run < 3; run++) {
            await distillBranch(repoRoot, {
                branch: 'feat/billing',
                defaultBranch: 'main',
                runAgent: makeAgent(BILLING_DECISIONS).run,
            });
        }

        const records = await readAllBranchRecords(repoRoot);
        expect(records).toHaveLength(1);
        expect(records[0].decisions).toHaveLength(1);

        const local = await readAllLocalBranchRecords(repoRoot);
        expect(local).toHaveLength(1);
    });

    it('reuses per-commit summaries and only pays for the new commit', async () => {
        await commitFile(repoRoot, 'src/billing/invoice.ts', 'a\n', 'feat: a');
        await commitFile(repoRoot, 'src/billing/total.ts', 'b\n', 'feat: b');

        const first = makeAgent(BILLING_DECISIONS);
        const firstResult = await distillBranch(repoRoot, {
            branch: 'feat/billing',
            defaultBranch: 'main',
            runAgent: first.run,
        });
        expect(firstResult.commitsProcessed).toBe(2);
        expect(firstResult.commitsReused).toBe(0);

        await commitFile(repoRoot, 'src/billing/tax.ts', 'c\n', 'feat: c');

        const second = makeAgent(BILLING_DECISIONS);
        const secondResult = await distillBranch(repoRoot, {
            branch: 'feat/billing',
            defaultBranch: 'main',
            runAgent: second.run,
        });

        // Still the whole merge-base..HEAD range…
        expect(secondResult.record.commits).toHaveLength(3);
        // …but only the commit it had not seen cost a model call.
        expect(secondResult.commitsProcessed).toBe(1);
        expect(secondResult.commitsReused).toBe(2);

        const head = await git(repoRoot, ['rev-parse', 'HEAD']);
        expect(await readCachedSummary(repoRoot, head.trim())).not.toBeNull();
    });

    it('shards two branches to different paths and keeps both records', async () => {
        await commitFile(repoRoot, 'src/billing/invoice.ts', 'a\n', 'feat: a');
        await distillBranch(repoRoot, {
            branch: 'feat/billing',
            defaultBranch: 'main',
            runAgent: makeAgent(BILLING_DECISIONS).run,
        });

        await git(repoRoot, ['checkout', '-q', '-b', 'feat/auth', 'main']);
        await commitFile(repoRoot, 'src/auth/login.ts', 'a\n', 'feat: auth');
        await distillBranch(repoRoot, {
            branch: 'feat/auth',
            defaultBranch: 'main',
            runAgent: makeAgent([
                {
                    type: 'convention',
                    decision: 'Sessions are stateless',
                    confidence: 0.6,
                    scope: ['src/auth'],
                },
            ]).run,
        });

        expect(recordPathForBranch('feat/billing')).not.toBe(
            recordPathForBranch('feat/auth'),
        );

        const records = await readAllBranchRecords(repoRoot);
        expect(records.map((r) => r.branch).sort()).toEqual([
            'feat/auth',
            'feat/billing',
        ]);
    });

    it('lands the record on kodus/trace/v1 and pushes it to the remote', async () => {
        await commitFile(repoRoot, 'src/billing/invoice.ts', 'a\n', 'feat: a');

        const result = await distillBranch(repoRoot, {
            branch: 'feat/billing',
            defaultBranch: 'main',
            runAgent: makeAgent(BILLING_DECISIONS).run,
        });

        expect(result.pushed).toBe(true);
        expect(result.pushError).toBeUndefined();

        const localRef = await git(repoRoot, ['rev-parse', TRACE_REF]);
        const remoteRef = await git(originDir, [
            'rev-parse',
            `refs/heads/${TRACE_BRANCH}`,
        ]);
        expect(remoteRef.trim()).toBe(localRef.trim());

        const record = await readBranchRecord(repoRoot, 'feat/billing');
        expect(record?.decisions[0].decision).toContain('Invoice totals');
    });

    it('works when the only remote is not named origin', async () => {
        await git(repoRoot, ['remote', 'rename', 'origin', 'upstream']);
        await commitFile(repoRoot, 'src/billing/invoice.ts', 'a\n', 'feat: a');

        const refspec = await configureTraceRefspec(repoRoot);
        expect(refspec.configured).toBe(true);
        expect(
            await git(repoRoot, [
                'config',
                '--get-all',
                'remote.upstream.fetch',
            ]),
        ).toContain('refs/remotes/upstream/kodus/trace/v1');

        const result = await distillBranch(repoRoot, {
            branch: 'feat/billing',
            defaultBranch: 'main',
            remote: 'upstream',
            runAgent: makeAgent(BILLING_DECISIONS).run,
        });
        expect(result.pushed).toBe(true);
        expect(await readBranchRecord(repoRoot, 'feat/billing')).not.toBeNull();
    });

    it('never checks the orphan branch out — the working tree is untouched', async () => {
        await commitFile(repoRoot, 'src/billing/invoice.ts', 'a\n', 'feat: a');

        await distillBranch(repoRoot, {
            branch: 'feat/billing',
            defaultBranch: 'main',
            runAgent: makeAgent(BILLING_DECISIONS).run,
        });

        expect((await git(repoRoot, ['status', '--porcelain'])).trim()).toBe(
            '',
        );
        expect(
            (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(),
        ).toBe('feat/billing');
    });

    it('a second clone reads the decisions the first clone pushed', async () => {
        await commitFile(repoRoot, 'src/billing/invoice.ts', 'a\n', 'feat: a');
        await git(repoRoot, ['push', '-q', 'origin', 'feat/billing']);
        await distillBranch(repoRoot, {
            branch: 'feat/billing',
            defaultBranch: 'main',
            runAgent: makeAgent(BILLING_DECISIONS).run,
        });

        const cloneDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'distill-clone-'),
        );
        try {
            await execa('git', ['clone', '-q', originDir, cloneDir], {
                env: GIT_ENV,
            });

            // No local configuration at all in the clone.
            const records = await readAllBranchRecords(cloneDir);
            expect(records).toHaveLength(1);
            expect(records[0].decisions[0].decision).toContain(
                'Invoice totals',
            );

            const recalled = await recallDecisions(cloneDir, {
                paths: ['src/billing/invoice.ts'],
            });
            expect(recalled.decisions.map((d) => d.source)).toEqual(['branch']);
        } finally {
            await fs.rm(cloneDir, { recursive: true, force: true });
        }
    });

    it('shares pin and forget across clones and preserves them on re-distillation', async () => {
        await commitFile(repoRoot, 'src/billing/invoice.ts', 'a\n', 'feat: a');
        const twoDecisions = [
            ...BILLING_DECISIONS,
            {
                type: 'tradeoff',
                decision: 'Keep tax rounding at invoice scope',
                confidence: 0.7,
                scope: ['src/billing'],
            },
        ];
        const first = await distillBranch(repoRoot, {
            branch: 'feat/billing',
            defaultBranch: 'main',
            runAgent: makeAgent(twoDecisions).run,
        });
        const [pinnedId, forgottenId] = first.record.decisions.map(
            (entry) => entry.id,
        );

        const cloneDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'distill-correction-clone-'),
        );
        const cloneHome = await fs.mkdtemp(
            path.join(os.tmpdir(), 'distill-correction-home-'),
        );
        try {
            await execa('git', ['clone', '-q', originDir, cloneDir], {
                env: GIT_ENV,
            });
            await git(cloneDir, [
                'fetch',
                'origin',
                `${TRACE_REF}:refs/remotes/origin/${TRACE_BRANCH}`,
            ]);
            process.env.KODUS_TRACE_HOME = cloneHome;
            expect((await recallDecisions(cloneDir)).decisions).toHaveLength(2);

            process.env.KODUS_TRACE_HOME = traceHome;
            expect(
                await updateSharedDecisionCorrection(repoRoot, pinnedId, 'pin'),
            ).toMatchObject({ found: true, pushed: true });
            expect(
                await updateSharedDecisionCorrection(
                    repoRoot,
                    forgottenId,
                    'forget',
                ),
            ).toMatchObject({ found: true, pushed: true });

            await git(cloneDir, [
                'fetch',
                'origin',
                `${TRACE_REF}:refs/remotes/origin/${TRACE_BRANCH}`,
            ]);
            process.env.KODUS_TRACE_HOME = cloneHome;
            const corrected = await recallDecisions(cloneDir);
            expect(corrected.decisions.map((entry) => entry.id)).toEqual([
                pinnedId,
            ]);
            expect(corrected.decisions[0].pinned).toBe(true);

            process.env.KODUS_TRACE_HOME = traceHome;
            const redistilled = await distillBranch(repoRoot, {
                branch: 'feat/billing',
                defaultBranch: 'main',
                runAgent: makeAgent(twoDecisions).run,
            });
            expect(
                redistilled.record.decisions.map((entry) => entry.id),
            ).toEqual([pinnedId]);
            expect(redistilled.record.decisions[0].pinned).toBe(true);
            expect(redistilled.record.corrections?.forgotten).toContain(
                forgottenId,
            );
        } finally {
            process.env.KODUS_TRACE_HOME = traceHome;
            await fs.rm(cloneDir, { recursive: true, force: true });
            await fs.rm(cloneHome, { recursive: true, force: true });
        }
    });

    it('writes a forget tombstone to every shard containing the decision id', async () => {
        await commitFile(repoRoot, 'src/billing/invoice.ts', 'a\n', 'feat: a');
        const first = await distillBranch(repoRoot, {
            branch: 'feat/billing',
            defaultBranch: 'main',
            runAgent: makeAgent(BILLING_DECISIONS).run,
        });
        const decision = first.record.decisions[0];

        const copiedRecord = {
            ...first.record,
            branch: 'feat/copied',
            decisions: [decision],
        };
        const indexDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'distill-copy-index-'),
        );
        try {
            const written = await writeBranchRecord(repoRoot, copiedRecord, {
                indexFile: path.join(indexDir, 'index'),
            });
            await pushTraceBranch(repoRoot, copiedRecord, {
                remote: 'origin',
                indexFile: path.join(indexDir, 'push-index'),
                sourceCommit: written.commit,
            });

            expect(
                await updateSharedDecisionCorrection(
                    repoRoot,
                    decision.id,
                    'forget',
                ),
            ).toMatchObject({ found: true, pushed: true });

            expect(
                (await readBranchRecord(repoRoot, 'feat/billing'))?.corrections
                    ?.forgotten,
            ).toContain(decision.id);
            expect(
                (await readBranchRecord(repoRoot, 'feat/copied'))?.corrections
                    ?.forgotten,
            ).toContain(decision.id);
        } finally {
            await fs.rm(indexDir, { recursive: true, force: true });
        }
    });

    it('keeps a concurrent remote correction when stale distillation retries', async () => {
        await commitFile(repoRoot, 'src/billing/invoice.ts', 'a\n', 'feat: a');
        const first = await distillBranch(repoRoot, {
            branch: 'feat/billing',
            defaultBranch: 'main',
            runAgent: makeAgent(BILLING_DECISIONS).run,
        });
        const decisionId = first.record.decisions[0].id;

        const otherDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'distill-correction-race-clone-'),
        );
        const otherHome = await fs.mkdtemp(
            path.join(os.tmpdir(), 'distill-correction-race-home-'),
        );
        try {
            await execa('git', ['clone', '-q', originDir, otherDir], {
                env: GIT_ENV,
            });
            await git(otherDir, [
                'fetch',
                'origin',
                `${TRACE_REF}:refs/remotes/origin/${TRACE_BRANCH}`,
            ]);
            process.env.KODUS_TRACE_HOME = otherHome;
            expect(
                await updateSharedDecisionCorrection(
                    otherDir,
                    decisionId,
                    'pin',
                ),
            ).toMatchObject({ found: true, pushed: true });

            // repoRoot still has the pre-correction local Trace ref. Its first
            // push loses the race, then the NFF retry must merge from the
            // freshly fetched remote ref rather than rereading that stale ref.
            process.env.KODUS_TRACE_HOME = traceHome;
            const redistilled = await distillBranch(repoRoot, {
                branch: 'feat/billing',
                defaultBranch: 'main',
                runAgent: makeAgent(BILLING_DECISIONS).run,
            });
            expect(redistilled.pushRetried).toBe(true);
            expect(redistilled.pushed).toBe(true);
            expect(
                (await readBranchRecord(repoRoot, 'feat/billing'))?.decisions[0]
                    .pinned,
            ).toBe(true);
        } finally {
            process.env.KODUS_TRACE_HOME = traceHome;
            await fs.rm(otherDir, { recursive: true, force: true });
            await fs.rm(otherHome, { recursive: true, force: true });
        }
    });

    it('retries a rejected push once with a rebase and keeps the other record', async () => {
        // Another developer pushes their own branch record first.
        const otherDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'distill-other-'),
        );
        const otherHome = await fs.mkdtemp(
            path.join(os.tmpdir(), 'distill-other-home-'),
        );

        try {
            await execa('git', ['clone', '-q', originDir, otherDir], {
                env: GIT_ENV,
            });
            await git(otherDir, ['checkout', '-q', '-b', 'feat/auth']);
            await commitFile(
                otherDir,
                'src/auth/login.ts',
                'a\n',
                'feat: auth',
            );

            process.env.KODUS_TRACE_HOME = otherHome;
            await distillBranch(otherDir, {
                branch: 'feat/auth',
                defaultBranch: 'main',
                runAgent: makeAgent([
                    {
                        type: 'convention',
                        decision: 'Sessions are stateless',
                        confidence: 0.6,
                        scope: ['src/auth'],
                    },
                ]).run,
            });
            process.env.KODUS_TRACE_HOME = traceHome;

            // Our clone knows nothing about that push, so its first attempt is
            // a non-fast-forward.
            await commitFile(
                repoRoot,
                'src/billing/invoice.ts',
                'a\n',
                'feat: a',
            );
            const result = await distillBranch(repoRoot, {
                branch: 'feat/billing',
                defaultBranch: 'main',
                runAgent: makeAgent(BILLING_DECISIONS).run,
            });

            expect(result.pushRetried).toBe(true);
            expect(result.pushed).toBe(true);

            const records = await readAllBranchRecords(repoRoot);
            expect(records.map((r) => r.branch).sort()).toEqual([
                'feat/auth',
                'feat/billing',
            ]);
        } finally {
            await fs.rm(otherDir, { recursive: true, force: true });
            await fs.rm(otherHome, { recursive: true, force: true });
        }
    });

    it('reports a collision that survives the retry instead of swallowing it', async () => {
        await commitFile(repoRoot, 'src/billing/invoice.ts', 'a\n', 'feat: a');
        // Point the remote at nothing so every push fails.
        await git(repoRoot, [
            'remote',
            'set-url',
            'origin',
            path.join(os.tmpdir(), 'kodus-trace-nonexistent-remote'),
        ]);

        const result = await distillBranch(repoRoot, {
            branch: 'feat/billing',
            defaultBranch: 'main',
            runAgent: makeAgent(BILLING_DECISIONS).run,
        });

        expect(result.pushed).toBe(false);
        expect(result.pushError).toBeTruthy();

        const incidents = await readIncidents(repoRoot);
        expect(incidents[0]?.kind).toBe('push-collision');
        expect(incidents[0]?.branch).toBe('feat/billing');

        // The local record still landed, so recall keeps working offline.
        const local = await readAllLocalBranchRecords(repoRoot);
        expect(local[0].decisions).toHaveLength(1);
    });

    it('carries sessions captured on the branch into the aggregate prompt', async () => {
        await commitFile(repoRoot, 'src/billing/invoice.ts', 'a\n', 'feat: a');

        await appendRecordLine(repoRoot, 'sess-1', {
            kind: 'session-start',
            sessionId: 'sess-1',
            agentType: 'claude-code',
            branch: 'feat/billing',
            baseCommit: 'abc',
            gitRemote: '',
            cliVersion: '1.0.0',
            timestamp: '2026-01-01T00:00:00.000Z',
        });
        await appendRecordLine(repoRoot, 'sess-1', {
            kind: 'turn-start',
            turnId: 't1',
            prompt: 'cache the invoice total',
            commitBefore: 'abc',
            timestamp: '2026-01-01T00:00:01.000Z',
        });

        const agent = makeAgent(BILLING_DECISIONS);
        const result = await distillBranch(repoRoot, {
            branch: 'feat/billing',
            defaultBranch: 'main',
            runAgent: agent.run,
        });

        const aggregatePrompt = agent.calls.at(-1)!;
        expect(aggregatePrompt).toContain('cache the invoice total');
        expect(result.record.decisions[0].sessionIds).toContain('sess-1');
    });

    it('survives a model that returns nothing useful', async () => {
        await commitFile(repoRoot, 'src/billing/invoice.ts', 'a\n', 'feat: a');

        const result = await distillBranch(repoRoot, {
            branch: 'feat/billing',
            defaultBranch: 'main',
            runAgent: async () => 'I am afraid I cannot do that.',
        });

        expect(result.record.decisions).toEqual([]);
    });

    it('redacts secrets returned by the model before every decision store', async () => {
        await commitFile(repoRoot, 'src/billing/invoice.ts', 'a\n', 'feat: a');
        const secret = ['sk-', 'Q'.repeat(32)].join('');

        const result = await distillBranch(repoRoot, {
            branch: 'feat/billing',
            defaultBranch: 'main',
            runAgent: async (prompt) =>
                prompt.startsWith('Summarize one commit')
                    ? JSON.stringify({
                          summary: `summary ${secret}`,
                          points: [`point ${secret}`],
                      })
                    : JSON.stringify({
                          decisions: [
                              {
                                  type: 'convention',
                                  decision: `never store ${secret}`,
                                  rationale: `because ${secret} is private`,
                                  evidence: [`observed ${secret}`],
                                  confidence: 0.9,
                                  scope: ['src/billing'],
                              },
                          ],
                      }),
        });

        expect(JSON.stringify(result.record)).not.toContain(secret);
        expect(JSON.stringify(result.record)).toContain('[REDACTED]');

        const head = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();
        expect(
            JSON.stringify(await readCachedSummary(repoRoot, head)),
        ).not.toContain(secret);
        expect(
            JSON.stringify(await readBranchRecord(repoRoot, 'feat/billing')),
        ).not.toContain(secret);
        expect(
            JSON.stringify(await readAllLocalBranchRecords(repoRoot)),
        ).not.toContain(secret);
    });
});

describe('parseJsonObject', () => {
    it('parses bare JSON', () => {
        expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    });

    it('parses a fenced block wrapped in prose', () => {
        expect(
            parseJsonObject('Sure!\n```json\n{"a":1}\n```\nHope that helps.'),
        ).toEqual({ a: 1 });
    });

    it('parses the first balanced object in unfenced prose', () => {
        expect(parseJsonObject('Here: {"a":{"b":2}} done')).toEqual({
            a: { b: 2 },
        });
    });

    it('is not fooled by braces inside strings', () => {
        expect(parseJsonObject('{"a":"}"}')).toEqual({ a: '}' });
    });

    it('returns null when there is no object', () => {
        expect(parseJsonObject('nope')).toBeNull();
        expect(parseJsonObject('')).toBeNull();
        expect(parseJsonObject('[1,2]')).toBeNull();
    });
});
