import { AnalyzerToolRouter } from '@libs/code-review/infrastructure/analyzers/analyzer-tool.router';
import { AnalyzerTool } from '@libs/code-review/infrastructure/analyzers/tool.contract';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { RunAnalyzersStage } from './run-analyzers.stage';

/** A patch adding `count` lines starting at `start`. */
const patchAdding = (start: number, count: number) =>
    [
        `@@ -${start},0 +${start},${count} @@`,
        ...Array.from({ length: count }, (_, i) => `+line ${start + i}`),
    ].join('\n');

const finding = (overrides: Record<string, unknown> = {}) => ({
    ruleId: 'kodus-sqli-concat-go',
    path: 'src/db/orders.go',
    startLine: 11,
    endLine: 11,
    severity: 'error' as const,
    message: 'SQL built by concatenation',
    ...overrides,
});

const makeTool = (overrides: Partial<AnalyzerTool> = {}): AnalyzerTool => ({
    id: 'dependencies',
    selectFiles: (files) => files,
    run: jest.fn().mockResolvedValue([finding()]),
    ...overrides,
});

const makeContext = (
    overrides: Partial<CodeReviewPipelineContext> = {},
): CodeReviewPipelineContext =>
    ({
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: 'repo-1', name: 'widget-api' },
        pullRequest: { number: 42 },
        codeReviewConfig: {
            deterministicEvidence: { tools: { dependencies: 'on' } },
        },
        changedFiles: [
            { filename: 'src/db/orders.go', patch: patchAdding(10, 3) },
        ],
        sandboxHandle: {
            repoDir: '/repo',
            run: jest.fn(),
            writeFile: jest.fn(),
        },
        ...overrides,
    }) as unknown as CodeReviewPipelineContext;

describe('RunAnalyzersStage', () => {
    const makeStage = (tools: AnalyzerTool[], gateEnabled = true) =>
        new RunAnalyzersStage(
            new AnalyzerToolRouter(),
            { isEnabled: jest.fn().mockResolvedValue(gateEnabled) } as never,
            // Nothing to recover unless a selected file arrived without a patch.
            { getFilePatches: jest.fn().mockResolvedValue([]) } as never,
            tools,
        );

    const run = (
        stage: RunAnalyzersStage,
        context: CodeReviewPipelineContext,
    ) =>
        (
            stage as unknown as {
                executeStage: (
                    c: CodeReviewPipelineContext,
                ) => Promise<CodeReviewPipelineContext>;
            }
        ).executeStage(context);

    it('stores findings that land on added lines', async () => {
        const result = await run(makeStage([makeTool()]), makeContext());

        expect(result.analyzerFindings).toEqual([
            expect.objectContaining({ ruleId: 'kodus-sqli-concat-go' }),
        ]);
    });

    // Pre-existing findings are not this PR's problem, and reporting them is
    // how a deterministic pass becomes noise on every review.
    it('drops findings outside the added lines', async () => {
        const tool = makeTool({
            run: jest.fn().mockResolvedValue([finding({ startLine: 99 })]),
        });

        const result = await run(makeStage([tool]), makeContext());

        expect(result.analyzerFindings).toBeUndefined();
    });

    it('drops findings in files the PR did not touch', async () => {
        const tool = makeTool({
            run: jest.fn().mockResolvedValue([finding({ path: 'other.go' })]),
        });

        const result = await run(makeStage([tool]), makeContext());

        expect(result.analyzerFindings).toBeUndefined();
    });

    it('passes each tool only the files it selected', async () => {
        const selectFiles = jest
            .fn()
            .mockReturnValue([
                { filename: 'src/db/orders.go', patch: patchAdding(10, 3) },
            ]);
        const tool = makeTool({ selectFiles });

        await run(makeStage([tool]), makeContext());

        expect(tool.run).toHaveBeenCalledWith(
            expect.objectContaining({
                files: [
                    expect.objectContaining({ filename: 'src/db/orders.go' }),
                ],
            }),
        );
    });

    // The issue asks us to record why each tool did or did not run.
    describe('routing record', () => {
        it('records the decision for a tool that ran', async () => {
            const result = await run(makeStage([makeTool()]), makeContext());

            expect(result.analyzerRouting).toEqual([
                { toolId: 'dependencies', run: true, fileCount: 1 },
            ]);
        });

        it('records the reason a tool was skipped', async () => {
            const context = makeContext({
                codeReviewConfig: {
                    deterministicEvidence: { tools: { dependencies: 'off' } },
                },
            } as unknown as Partial<CodeReviewPipelineContext>);

            const result = await run(makeStage([makeTool()]), context);

            expect(result.analyzerRouting).toEqual([
                expect.objectContaining({ reason: 'disabled-by-config' }),
            ]);
        });

        it('records routing even with no sandbox to run in', async () => {
            const context = makeContext({
                sandboxHandle: undefined,
            } as Partial<CodeReviewPipelineContext>);

            const result = await run(makeStage([makeTool()]), context);

            expect(result.analyzerRouting).toHaveLength(1);
            expect(result.analyzerFindings).toBeUndefined();
        });
    });

    describe('degradation', () => {
        // One failing tool must not cost the findings of the others.
        it('keeps other tools findings when one fails', async () => {
            const failing = makeTool({
                run: jest.fn().mockRejectedValue(new Error('binary missing')),
            });
            const working = makeTool({ id: 'dependencies' });

            const result = await run(
                makeStage([failing, working]),
                makeContext(),
            );

            expect(result.analyzerFindings).toHaveLength(1);
            expect(result.analyzerFailures).toEqual(['dependencies']);
        });

        // A failure must never read as "scanned and clean".
        it('records the failure when the only tool fails', async () => {
            const tool = makeTool({
                run: jest.fn().mockRejectedValue(new Error('binary missing')),
            });

            const result = await run(makeStage([tool]), makeContext());

            expect(result.analyzerFindings).toBeUndefined();
            expect(result.analyzerFailures).toEqual(['dependencies']);
        });

        it('does nothing when the beta gate is closed', async () => {
            const tool = makeTool();

            const result = await run(makeStage([tool], false), makeContext());

            expect(tool.run).not.toHaveBeenCalled();
            expect(result.analyzerRouting).toBeUndefined();
        });

        it('runs no tool when none is registered', async () => {
            const result = await run(makeStage([]), makeContext());

            expect(result.analyzerRouting).toEqual([]);
            expect(result.analyzerFindings).toBeUndefined();
        });
    });

    /**
     * `ignorePaths` carries lockfiles by default. Without this the dependency
     * scan can never fire on a real repository, which is how it shipped and
     * what the first end-to-end run caught.
     */
    const filesSeenBy = async (extra: Partial<AnalyzerTool>) => {
        const selectFiles = jest.fn((files: unknown[]) => files);
        const tool = makeTool({
            id: 'dependencies',
            selectFiles: selectFiles as never,
            ...extra,
        });

        await run(
            makeStage([tool]),
            makeContext({
                changedFiles: [
                    { filename: 'src/a.ts', patch: '@@ -0,0 +1 @@\n+x' },
                ],
                ignoredFileChanges: [
                    { filename: 'yarn.lock', patch: '@@ -0,0 +1 @@\n+lodash' },
                ],
            } as never),
        );

        return (
            (selectFiles.mock.calls.at(-1)?.[0] ?? []) as Array<{
                filename: string;
            }>
        ).map((f) => f.filename);
    };

    it('scans files that ignorePaths filtered out, for a tool that asks', async () => {
        // Lockfiles are on the default ignore list and are the only place a
        // dependency advisory can be found.
        expect(await filesSeenBy({ readsIgnoredFiles: true })).toContain(
            'yarn.lock',
        );
    });

    it('withholds them from a tool that does not', async () => {
        // `ignorePaths` means "do not comment on this file". A credential
        // reported from an excluded path is a comment the customer
        // explicitly asked not to receive.
        const seen = await filesSeenBy({});

        expect(seen).not.toContain('yarn.lock');
        expect(seen).toContain('src/a.ts');
    });
});

describe('host path spelling', () => {
    it('keeps a finding whose file the host spells with a leading slash', async () => {
        // Azure Repos reports "/src/app.ts"; the scanner, running against the
        // checkout, reports "src/app.ts". Without mapping the finding back to
        // the host's spelling clipToDiff loses it as "outside the diff".
        const tool = makeTool({
            run: jest
                .fn()
                .mockResolvedValue([
                    finding({ path: 'src/app.ts', startLine: 2 }),
                ]),
        });

        const stage = new RunAnalyzersStage(
            new AnalyzerToolRouter(),
            { isEnabled: jest.fn().mockResolvedValue(true) } as never,
            { getFilePatches: jest.fn().mockResolvedValue([]) } as never,
            [tool],
        );

        const context = makeContext({
            changedFiles: [
                { filename: '/src/app.ts', patch: patchAdding(1, 3) },
            ],
        } as never);

        const result = await (
            stage as unknown as {
                executeStage: (c: unknown) => Promise<{
                    analyzerFindings?: Array<{ path: string }>;
                }>;
            }
        ).executeStage(context);

        expect(result.analyzerFindings).toHaveLength(1);
        expect(result.analyzerFindings?.[0].path).toBe('/src/app.ts');
    });
});

/**
 * `ignorePaths` has to hold all the way to the published comment. Two ways it
 * leaked: a tool whose selection came out empty was still launched — and a
 * scanner given no targets falls back to the whole checkout — and clipping
 * matched findings against every file the STAGE saw, ignored ones included.
 */
describe('a tool that may not read ignored files', () => {
    const contextWithOnlyIgnored = () =>
        makeContext({
            changedFiles: [],
            ignoredFileChanges: [
                {
                    filename: 'fixtures/tok.ts',
                    patch: '@@ -0,0 +1 @@\n+secret',
                },
            ],
        } as never);

    it('is not launched at all when everything it could scan was ignored', async () => {
        const run = jest.fn().mockResolvedValue([]);
        const tool = makeTool({
            run,
            selectFiles: ((f: unknown[]) => f) as never,
        });

        const stage = new RunAnalyzersStage(
            new AnalyzerToolRouter(),
            { isEnabled: jest.fn().mockResolvedValue(true) } as never,
            { getFilePatches: jest.fn().mockResolvedValue([]) } as never,
            [tool],
        );

        await (
            stage as unknown as {
                executeStage: (c: unknown) => Promise<unknown>;
            }
        ).executeStage(contextWithOnlyIgnored());

        expect(run).not.toHaveBeenCalled();
    });

    it('cannot publish a finding anchored on an ignored file', async () => {
        // A tool that reads ignored files reports one anyway; clipping must
        // still drop it, because the review was told not to comment there.
        const tool = makeTool({
            readsIgnoredFiles: true,
            selectFiles: ((files: Array<{ filename: string }>) =>
                files.filter((f) => f.filename === 'src/a.ts')) as never,
            run: jest
                .fn()
                .mockResolvedValue([
                    finding({ path: 'fixtures/tok.ts', startLine: 1 }),
                ]),
        });

        const stage = new RunAnalyzersStage(
            new AnalyzerToolRouter(),
            { isEnabled: jest.fn().mockResolvedValue(true) } as never,
            { getFilePatches: jest.fn().mockResolvedValue([]) } as never,
            [tool],
        );

        const result = await (
            stage as unknown as {
                executeStage: (c: unknown) => Promise<{
                    analyzerFindings?: unknown[];
                }>;
            }
        ).executeStage(
            makeContext({
                changedFiles: [
                    { filename: 'src/a.ts', patch: patchAdding(1, 3) },
                ],
                ignoredFileChanges: [
                    {
                        filename: 'fixtures/tok.ts',
                        patch: patchAdding(1, 3),
                    },
                ],
            } as never),
        );

        expect(result.analyzerFindings ?? []).toEqual([]);
    });
});
