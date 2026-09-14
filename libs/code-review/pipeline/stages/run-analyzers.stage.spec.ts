import { ManagedTool } from '@libs/code-review/infrastructure/adapters/services/ci-evidence/recognize-ci-analyzers';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { RunAnalyzersStage } from './run-analyzers.stage';

const sarif = (
    results: Array<{ rule: string; path: string; line: number }>,
) =>
    JSON.stringify({
        runs: [
            {
                results: results.map((r) => ({
                    ruleId: `libs.rule-pack.${r.rule}`,
                    level: 'error',
                    message: { text: 'SQL built by concatenation' },
                    locations: [
                        {
                            physicalLocation: {
                                artifactLocation: { uri: `/repo/${r.path}` },
                                region: { startLine: r.line, endLine: r.line },
                            },
                        },
                    ],
                })),
            },
        ],
    });

/** A patch adding lines 10-12 of the file. */
const patchAdding = (start: number, count: number) =>
    [
        `@@ -${start},0 +${start},${count} @@`,
        ...Array.from({ length: count }, (_, i) => `+line ${start + i}`),
    ].join('\n');

const makeContext = (
    overrides: Partial<CodeReviewPipelineContext> = {},
): CodeReviewPipelineContext =>
    ({
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: 'repo-1', name: 'widget-api' },
        pullRequest: { number: 42 },
        codeReviewConfig: { deterministicEvidence: { rulePack: 'on' } },
        changedFiles: [
            {
                filename: 'src/db/orders.go',
                patch: patchAdding(10, 3),
            },
        ],
        sandboxHandle: {
            repoDir: '/repo',
            run: jest.fn().mockResolvedValue({ stdout: '', exitCode: 0 }),
            writeFile: jest.fn().mockResolvedValue(undefined),
            readFile: jest.fn().mockResolvedValue(sarif([])),
        },
        ...overrides,
    }) as unknown as CodeReviewPipelineContext;

describe('RunAnalyzersStage', () => {
    const makeStage = (
        rulePack: Record<string, string> = { 'sql.yaml': 'rules: []' },
        gateEnabled = true,
    ) =>
        new RunAnalyzersStage({ load: () => rulePack } as never, {
            isEnabled: jest.fn().mockResolvedValue(gateEnabled),
        } as never);

    const run = (stage: RunAnalyzersStage, context: CodeReviewPipelineContext) =>
        (
            stage as unknown as {
                executeStage: (
                    c: CodeReviewPipelineContext,
                ) => Promise<CodeReviewPipelineContext>;
            }
        ).executeStage(context);

    const withSarif = (text: string, ctx = {}) => {
        const context = makeContext(ctx);
        (context.sandboxHandle.readFile as jest.Mock).mockResolvedValue(text);
        return context;
    };

    it('stores findings that land on added lines', async () => {
        const context = withSarif(
            sarif([{ rule: 'kodus-sqli-concat-go', path: 'src/db/orders.go', line: 11 }]),
        );

        const result = await run(makeStage(), context);

        expect(result.analyzerFindings).toEqual([
            expect.objectContaining({
                ruleId: 'kodus-sqli-concat-go',
                path: 'src/db/orders.go',
                startLine: 11,
            }),
        ]);
    });

    // Pre-existing findings are not this PR's problem, and reporting them is
    // how a deterministic pass turns into noise on every review.
    it('drops findings outside the added lines', async () => {
        const context = withSarif(
            sarif([{ rule: 'kodus-sqli-concat-go', path: 'src/db/orders.go', line: 99 }]),
        );

        const result = await run(makeStage(), context);

        expect(result.analyzerFindings).toBeUndefined();
    });

    it('drops findings in files the PR did not touch', async () => {
        const context = withSarif(
            sarif([{ rule: 'kodus-sqli-concat-go', path: 'src/other.go', line: 11 }]),
        );

        const result = await run(makeStage(), context);

        expect(result.analyzerFindings).toBeUndefined();
    });

    it('writes the rule pack into the sandbox before scanning', async () => {
        const context = makeContext();

        await run(makeStage({ 'sql.yaml': 'rules: []', 'xss.yaml': 'rules: []' }), context);

        expect(context.sandboxHandle.writeFile).toHaveBeenCalledTimes(2);
        expect(context.sandboxHandle.run).toHaveBeenCalled();
    });

    // The providers disagree about relative paths — LocalSandbox resolves them
    // against the repo, E2B against the sandbox home — so every path must be
    // absolute and under repoDir. A mocked sandbox accepts anything, which is
    // exactly why this needs asserting.
    it('addresses every sandbox path absolutely, under the repo', async () => {
        const context = makeContext();

        await run(makeStage(), context);

        const writes = (context.sandboxHandle.writeFile as jest.Mock).mock.calls;
        expect(writes.length).toBeGreaterThan(0);
        for (const [path] of writes) {
            expect(path.startsWith('/repo/')).toBe(true);
        }

        const [[command]] = (context.sandboxHandle.run as jest.Mock).mock.calls;
        expect(command).toContain("--config '/repo/");
        expect(command).toContain("--output '/repo/");

        const [[readPath]] = (context.sandboxHandle.readFile as jest.Mock).mock
            .calls;
        expect(readPath.startsWith('/repo/')).toBe(true);
    });

    describe('gating', () => {
        // Beta feature: outside the release track nothing runs, whatever the
        // repository config says.
        it('does nothing when the beta gate is closed', async () => {
            const context = makeContext();

            await run(makeStage(undefined, false), context);

            expect(context.sandboxHandle.run).not.toHaveBeenCalled();
        });

        it('does nothing when the rule pack is off', async () => {
            const context = makeContext({
                codeReviewConfig: { deterministicEvidence: { rulePack: 'off' } },
            } as Partial<CodeReviewPipelineContext>);

            await run(makeStage(), context);

            expect(context.sandboxHandle.run).not.toHaveBeenCalled();
        });

        it('does nothing when the setting is absent', async () => {
            const context = makeContext({
                codeReviewConfig: {},
            } as Partial<CodeReviewPipelineContext>);

            await run(makeStage(), context);

            expect(context.sandboxHandle.run).not.toHaveBeenCalled();
        });

        // The whole point of reading their CI: do not pay to rediscover what
        // their pipeline already reported.
        it('skips on auto when the customer CI already runs an equivalent', async () => {
            const context = makeContext({
                codeReviewConfig: {
                    deterministicEvidence: { rulePack: 'auto' },
                },
                ciCoveredTools: [ManagedTool.RULE_PACK],
            } as Partial<CodeReviewPipelineContext>);

            await run(makeStage(), context);

            expect(context.sandboxHandle.run).not.toHaveBeenCalled();
        });

        it('runs on auto when their CI covers nothing equivalent', async () => {
            const context = makeContext({
                codeReviewConfig: {
                    deterministicEvidence: { rulePack: 'auto' },
                },
                ciCoveredTools: [],
            } as Partial<CodeReviewPipelineContext>);

            await run(makeStage(), context);

            expect(context.sandboxHandle.run).toHaveBeenCalled();
        });

        // `on` is an explicit instruction and outranks the coverage check.
        it('runs on "on" even when their CI covers it', async () => {
            const context = makeContext({
                codeReviewConfig: { deterministicEvidence: { rulePack: 'on' } },
                ciCoveredTools: [ManagedTool.RULE_PACK],
            } as Partial<CodeReviewPipelineContext>);

            await run(makeStage(), context);

            expect(context.sandboxHandle.run).toHaveBeenCalled();
        });
    });

    describe('degradation', () => {
        it('does nothing without a sandbox', async () => {
            const context = makeContext({
                sandboxHandle: undefined,
            } as Partial<CodeReviewPipelineContext>);

            const result = await run(makeStage(), context);

            expect(result.analyzerFindings).toBeUndefined();
        });

        it('does nothing when no files changed', async () => {
            const context = makeContext({
                changedFiles: [],
            } as Partial<CodeReviewPipelineContext>);

            await run(makeStage(), context);

            expect(context.sandboxHandle.run).not.toHaveBeenCalled();
        });

        // A missing binary must never read as "scanned and clean".
        it('warns rather than reporting clean when the analyzer is absent', async () => {
            const context = makeContext();
            (context.sandboxHandle.run as jest.Mock).mockResolvedValue({
                stdout: 'opengrep: command not found',
                exitCode: 127,
            });

            const result = await run(makeStage(), context);

            expect(result.analyzerFindings).toBeUndefined();
            expect(result.analyzerSkipped).toBe('unavailable');
        });

        it('survives a sandbox failure', async () => {
            const context = makeContext();
            (context.sandboxHandle.run as jest.Mock).mockRejectedValue(
                new Error('sandbox died'),
            );

            const result = await run(makeStage(), context);

            expect(result.analyzerFindings).toBeUndefined();
        });

        it('survives unparseable analyzer output', async () => {
            const context = withSarif('not json at all');

            const result = await run(makeStage(), context);

            expect(result.analyzerFindings).toBeUndefined();
        });
    });
});
