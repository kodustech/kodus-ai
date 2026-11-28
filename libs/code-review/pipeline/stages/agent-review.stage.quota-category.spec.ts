import { failedPrimaryReviewers } from './primary-review-agents';
import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import type { IAutomationExecutionService } from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { CodeReviewPipelineObserver } from '@libs/code-review/infrastructure/observers/code-review-pipeline.observer';
import { CheckConclusion } from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';
import type { IPipelineChecksService } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-checks-service.interface';
import { CheckStageNames } from '@libs/core/infrastructure/pipeline/services/pipeline-checks.service';
import { AgentReviewStage } from './agent-review.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { LLM } from '@libs/llm/llm';
import { hasManagedModelKey, resolveEnvProvider } from '@libs/llm/managed-slot';
import { attachAttemptedSlot } from '@libs/llm/model-failover';
import { environment } from '@libs/ee/configs/environment';

jest.mock(
    '@libs/code-review/infrastructure/agents/engine/classify-severity',
    () => ({ classifySeverity: jest.fn().mockResolvedValue(new Map()) }),
);
jest.mock(
    '@libs/code-review/infrastructure/agents/engine/format-suggestion-content',
    () => ({ formatSuggestionContent: jest.fn().mockResolvedValue(new Map()) }),
);
jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: true },
}));
jest.mock('@libs/llm/managed-slot', () => {
    const actual = jest.requireActual('@libs/llm/managed-slot');
    return {
        ...actual,
        hasManagedModelKey: jest.fn(() => false),
        resolveEnvProvider: jest.fn(() => null),
    };
});

/**
 * #2191 — the pipeline observer concludes the check from the LLM error
 * category of the recorded errors, so the stage has to put it there:
 * `metadata.category` is the agent's category, not the error's.
 */

const makeStage = (
    orchestratorOutput: Record<string, unknown>,
    graph: { generateContextLegacy?: jest.Mock } = {},
) => {
    const reviewOrchestrator = {
        execute: jest.fn().mockResolvedValue(orchestratorOutput),
    };
    const graphContext = {
        generateContext: jest.fn(),
        generateContextLegacy:
            graph.generateContextLegacy ?? jest.fn().mockResolvedValue(''),
    };
    const stage = new AgentReviewStage(
        {
            findLatestStageLog: jest.fn(),
            updateCodeReview: jest.fn(),
            updateStageLog: jest.fn(),
        } as any,
        { findByExternalId: jest.fn().mockResolvedValue(null) } as any,
        reviewOrchestrator as any,
        {
            runLLMInSpan: jest.fn(async ({ runFn }: any) => runFn?.()),
        } as any,
        graphContext as any,
        { isEnabled: jest.fn().mockResolvedValue(false) } as any,
        { getReleaseTrack: jest.fn().mockResolvedValue('stable') } as any,
        {
            getRepositories: jest.fn().mockResolvedValue([]),
            getCloneParams: jest.fn().mockResolvedValue(null),
        } as any,
    );
    return { stage, graphContext };
};

const makeContext = (over: Record<string, unknown> = {}) =>
    frozenContext({
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: 'repo-1', name: 'repo-1' },
        pullRequest: { number: 7 },
        platformType: 'GITHUB',
        changedFiles: [{ filename: 'src/user.ts' }],
        codeReviewConfig: {
            reviewOptions: {},
            resolvedModelSlot: { provider: 'openai', model: 'gpt-4o-mini' },
        },
        validSuggestions: [],
        discardedSuggestions: [],
        errors: [],
        ...over,
    }) as any as CodeReviewPipelineContext;

const run = (stage: AgentReviewStage, ctx: CodeReviewPipelineContext) =>
    (stage as any).executeStage(ctx) as Promise<any>;

let runSpy: jest.SpyInstance;
beforeEach(() => {
    runSpy = jest
        .spyOn(LLM, 'run')
        .mockResolvedValue({ groups: [], unique: [] } as any);
});
afterEach(() => {
    runSpy?.mockRestore();
    jest.clearAllMocks();
    (hasManagedModelKey as jest.Mock).mockReturnValue(false);
    (resolveEnvProvider as jest.Mock).mockReturnValue(null);
});

describe('AgentReviewStage — LLM error category on recorded failures (#2191)', () => {
    it('records the classified error category of a failed core agent', async () => {
        const { stage } = makeStage({
            suggestions: [],
            agentResults: [],
            failures: [
                {
                    agentName: 'generalist',
                    category: 'generalist',
                    error: Object.assign(new Error('Payment Required'), {
                        status: 402,
                    }),
                },
            ],
            incomplete: [],
            unverified: [],
            warnings: [],
        });

        const result = await run(stage, makeContext());

        const error = (result.errors ?? []).find(
            (e: any) => e.substage === 'agent:generalist',
        );
        expect(error?.severity).toBe('critical');
        expect(error?.metadata?.category).toBe('generalist');
        expect(error?.metadata?.errorCategory).toBe('QUOTA_EXCEEDED');
    });

    it('records UNKNOWN for a failure the classifier does not map', async () => {
        const { stage } = makeStage({
            suggestions: [],
            agentResults: [],
            failures: [
                {
                    agentName: 'bug',
                    category: 'bug',
                    error: new Error('something odd'),
                },
            ],
            incomplete: [],
            unverified: [],
            warnings: [],
        });

        const result = await run(stage, makeContext());

        const error = (result.errors ?? []).find(
            (e: any) => e.substage === 'agent:bug',
        );
        expect(error?.metadata?.errorCategory).toBe('UNKNOWN');
    });

    afterEach(() => {
        environment.API_CLOUD_MODE = true;
    });

    it.each([
        [
            'the org brought its own key',
            true,
            { credentialId: 'cred-1' },
            true,
            false,
        ],
        ['the Kodus-managed key served the run', true, {}, false, false],
        [
            'a platform-funded kodus credential served the run',
            true,
            { provider: 'kodus', credentialId: 'cred-2' },
            false,
            false,
        ],
        ['a self-hosted install used its env key', false, {}, true, true],
        [
            'a self-hosted install with no usable env key fell to the managed default',
            false,
            {},
            false,
            false,
        ],
    ])(
        'records whether %s',
        async (_label, cloud, slot, orgOwnedKey, envKey) => {
            environment.API_CLOUD_MODE = cloud;
            (resolveEnvProvider as jest.Mock).mockReturnValue(
                envKey ? { kind: 'openai_native', name: 'openai' } : null,
            );
            const { stage } = makeStage({
                suggestions: [],
                agentResults: [],
                failures: [
                    {
                        agentName: 'generalist',
                        category: 'generalist',
                        error: Object.assign(new Error('Payment Required'), {
                            status: 402,
                        }),
                    },
                ],
                incomplete: [],
                unverified: [],
                warnings: [],
            });

            const result = await run(
                stage,
                makeContext({
                    codeReviewConfig: {
                        reviewOptions: {},
                        resolvedModelSlot: {
                            provider: 'openai',
                            model: 'gpt-4o-mini',
                            ...slot,
                        },
                    },
                }),
            );

            const error = (result.errors ?? []).find(
                (e: any) => e.substage === 'agent:generalist',
            );
            expect(error?.metadata?.orgOwnedKey).toBe(orgOwnedKey);
        },
    );

    describe('agent failures at check finalization', () => {
        const finding = {
            relevantFile: 'src/user.ts',
            relevantLinesStart: 2,
            relevantLinesEnd: 2,
            label: 'bug',
            severity: 'high',
            suggestionContent: 'The caller reads an undefined user.',
            existingCode: 'return user.name;',
        };
        const bugAgent = (suggestions: (typeof finding)[]) => ({
            agentName: 'kodus-bug-review-agent',
            agentCategory: 'bug',
            finishReason: 'stop',
            turnsUsed: 2,
            suggestions,
        });
        const noMatchingRules = {
            agentName: 'kodus-rules-review-agent',
            turnsUsed: 0,
            suggestions: [],
        };
        const endStage = {
            [CheckConclusion.NEUTRAL]: CheckStageNames._pipelineEndPartial,
            [CheckConclusion.SKIPPED]: CheckStageNames._pipelineEndSkipped,
            [CheckConclusion.FAILURE]: CheckStageNames._pipelineEndFailure,
        };
        const failedAgent = (agentName: string, status: number) => ({
            agentName,
            category: agentName,
            error: Object.assign(new Error('Provider request failed'), {
                status,
            }),
        });
        const reviewContext = (orgOwned: boolean) =>
            makeContext({
                changedFiles: [
                    {
                        filename: 'src/user.ts',
                        patch: '@@ -1 +1,2 @@\n const user = getUser();\n+return user.name;',
                    },
                ],
                statusInfo: { status: AutomationStatus.IN_PROGRESS },
                codeReviewConfig: {
                    reviewOptions: {},
                    resolvedModelSlot: {
                        provider: 'openai',
                        model: 'gpt-4o-mini',
                        ...(orgOwned && { credentialId: 'cred-1' }),
                    },
                },
            });

        it.each([
            [
                'another agent found a bug',
                [bugAgent([finding])],
                true,
                402,
                'partial',
                CheckConclusion.NEUTRAL,
            ],
            [
                'another agent found no issues',
                [bugAgent([])],
                true,
                402,
                'partial',
                CheckConclusion.NEUTRAL,
            ],
            [
                'the only agent ran out of org credits',
                [],
                true,
                402,
                'critical',
                CheckConclusion.SKIPPED,
            ],
            [
                'Kody Rules had no applicable rules',
                [noMatchingRules],
                true,
                402,
                'critical',
                CheckConclusion.SKIPPED,
            ],
            [
                'only Kody Rules completed a review',
                [{ ...noMatchingRules, turnsUsed: 2 }],
                true,
                402,
                'critical',
                CheckConclusion.SKIPPED,
            ],
            [
                'a scoped custom agent returned a finding that was never posted',
                [
                    {
                        ...bugAgent([finding]),
                        agentName: 'custom-agent:style',
                        agentCategory: 'custom_agent',
                    },
                ],
                true,
                402,
                'critical',
                CheckConclusion.SKIPPED,
            ],
            [
                'a Kodus-managed key ran out of credits',
                [bugAgent([])],
                false,
                402,
                'critical',
                CheckConclusion.FAILURE,
            ],
            [
                'the org key had a different error',
                [bugAgent([])],
                true,
                405,
                'critical',
                CheckConclusion.FAILURE,
            ],
        ] as const)(
            'classifies the review when %s',
            async (
                _case,
                agentResults,
                orgOwned,
                status,
                severity,
                conclusion,
            ) => {
                const suggestions = agentResults.flatMap(
                    (agent) => agent.suggestions,
                );
                const { stage } = makeStage({
                    suggestions,
                    agentResults,
                    failures: [failedAgent('security', status)],
                    incomplete: [],
                    unverified: [],
                    warnings: [],
                });
                const context = await run(stage, reviewContext(orgOwned));

                expect(context.validSuggestions).toHaveLength(
                    suggestions.length,
                );
                const finalizeCheck = jest.fn();
                const observer = new CodeReviewPipelineObserver(
                    {} as IAutomationExecutionService,
                    { finalizeCheck } as unknown as IPipelineChecksService,
                );
                await observer.onPipelineFinish(context, {});
                expect(finalizeCheck).toHaveBeenCalledWith(
                    {},
                    context,
                    conclusion,
                    endStage[conclusion],
                    '- Provider request failed',
                );
                expect(context.errors).toMatchObject([
                    { substage: 'agent:security', severity },
                ]);
            },
        );

        it.each([
            [
                'ran out of steps',
                { hitHardLimit: true, finishReason: 'max-steps' },
            ],
            ['returned without a finish reason', { finishReason: undefined }],
            [
                'reported a stop despite hitting its limit',
                { hitHardLimit: true },
            ],
            [
                'could not verify its finding',
                { discardedByVerifyError: [finding] },
            ],
            [
                'had the same category as the failed agent',
                { agentCategory: 'security' },
            ],
        ] as const)(
            'keeps a quota failure critical when the other result %s',
            async (_case, outcome) => {
                const { stage } = makeStage({
                    suggestions: [],
                    agentResults: [{ ...bugAgent([]), ...outcome }],
                    failures: [failedAgent('security', 402)],
                });

                const context = await run(stage, reviewContext(true));

                const quotaFailure = context.errors.find(
                    (e) => e.substage === 'agent:security',
                );
                expect(quotaFailure.severity).toBe('critical');
            },
        );

        it('attributes a mixed failure to the agent with the critical error', async () => {
            const { stage } = makeStage({
                suggestions: [],
                agentResults: [bugAgent([])],
                failures: [
                    failedAgent('security', 402),
                    failedAgent('performance', 405),
                ],
            });

            const context = await run(stage, reviewContext(true));

            expect(context.lastReviewError?.agentName).toBe('performance');
        });

        it('attributes a partial run to the failed primary reviewer, not an auxiliary agent', async () => {
            const { stage } = makeStage({
                suggestions: [],
                agentResults: [bugAgent([])],
                failures: [
                    failedAgent('kodyRules', 429),
                    failedAgent('security', 402),
                ],
            });

            const context = await run(stage, reviewContext(true));

            expect(
                context.errors.map(({ substage, severity }) => ({
                    substage,
                    severity,
                })),
            ).toEqual([
                { substage: 'agent:kodyRules', severity: 'partial' },
                { substage: 'agent:security', severity: 'partial' },
            ]);
            expect(context.lastReviewError?.agentName).toBe('security');
        });

        it.each([
            ['two primary reviewers', []],
            ['two primary reviewers and Kody Rules', ['kodyRules']],
        ] as const)(
            'names every primary reviewer out of credits: %s',
            async (_case, auxiliary) => {
                const { stage } = makeStage({
                    suggestions: [],
                    agentResults: [bugAgent([])],
                    failures: [
                        failedAgent('security', 402),
                        failedAgent('performance', 402),
                        ...auxiliary.map((name) => failedAgent(name, 402)),
                    ],
                });

                const context = await run(stage, reviewContext(true));

                expect(
                    failedPrimaryReviewers(
                        context.lastReviewError?.agentName,
                        context.errors,
                    ),
                ).toEqual(['security', 'performance']);
            },
        );

        it.each([
            ['one primary reviewer', ['security'], 'security'],
            ['Kody Rules only', ['kodyRules'], 'kodyRules'],
            ['a custom agent only', ['custom-acme'], 'custom-acme'],
        ] as const)(
            'keeps the single attributed agent for %s',
            async (_case, failed, expected) => {
                const { stage } = makeStage({
                    suggestions: [],
                    agentResults: [bugAgent([])],
                    failures: failed.map((name) => failedAgent(name, 402)),
                });

                const context = await run(stage, reviewContext(true));

                expect(
                    failedPrimaryReviewers(
                        context.lastReviewError?.agentName,
                        context.errors,
                    ),
                ).toBe(expected);
            },
        );
    });

    it('judges ownership by the attempt that failed, not the pre-run slot', async () => {
        const error = attachAttemptedSlot(
            Object.assign(new Error('Payment Required'), { status: 402 }),
            { provider: 'kodus', model: 'kodus-default' } as any,
        );
        const { stage } = makeStage({
            suggestions: [],
            agentResults: [],
            failures: [
                { agentName: 'generalist', category: 'generalist', error },
            ],
            incomplete: [],
            unverified: [],
            warnings: [],
        });

        const result = await run(
            stage,
            makeContext({
                codeReviewConfig: {
                    reviewOptions: {},
                    resolvedModelSlot: {
                        provider: 'openai',
                        model: 'gpt-4o-mini',
                        credentialId: 'cred-1',
                    },
                },
            }),
        );

        const recorded = (result.errors ?? []).find(
            (e: any) => e.substage === 'agent:generalist',
        );
        expect(recorded?.metadata?.orgOwnedKey).toBe(false);
    });
});
