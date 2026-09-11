/**
 * Guards the context → agent-input wiring that no typecheck would catch: the
 * fields are OPTIONAL, so a refactor that silently stops forwarding one (most
 * importantly `reviewDirective` from `@kody review <directive>`) would leave the
 * feature dead with every other test still green. Testing the pure mapping is
 * the cheap, durable seam for that.
 */
import {
    buildOrchestratorInput,
    type OrchestratorInputComputed,
} from './build-orchestrator-input';
import type { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { NULL_SANDBOX_INSTANCE } from '@libs/sandbox/infrastructure/providers/null-sandbox.service';

const computed: OrchestratorInputComputed = {
    changedFiles: [],
    prNumber: 1,
    repositoryId: 'repo-1',
    reviewOptions: {} as any,
    onAgentProgress: () => undefined,
    gitHubToken: undefined,
    callGraph: '',
    adaptiveProfile: { skipHeavyPasses: false } as any,
    linkedRepoAccess: undefined,
};

const makeContext = (
    over: Record<string, unknown> = {},
): CodeReviewPipelineContext =>
    ({
        organizationAndTeamData: { organizationId: 'o', teamId: 't' },
        pullRequest: { title: 'T', body: 'B' },
        repository: { fullName: 'kodus/test' },
        codeReviewConfig: {},
        ...over,
    }) as unknown as CodeReviewPipelineContext;

describe('buildOrchestratorInput — context→agent wiring', () => {
    it('forwards reviewDirective from context into the agent input', () => {
        const input = buildOrchestratorInput(
            makeContext({
                reviewDirective: 'the auth and session logic',
            }),
            computed,
        );
        expect(input.reviewDirective).toBe('the auth and session logic');
    });

    it('leaves reviewDirective undefined for a normal review (no directive)', () => {
        expect(
            buildOrchestratorInput(makeContext(), computed).reviewDirective,
        ).toBeUndefined();
    });

    it('maps the load-bearing prompt fields from context', () => {
        const input = buildOrchestratorInput(
            makeContext({
                pullRequest: { title: 'My PR', body: 'desc' },
                codeReviewConfig: { reviewMode: 'deep' },
            }),
            computed,
        );
        expect(input.prTitle).toBe('My PR');
        expect(input.prBody).toBe('desc');
        expect(input.reviewMode).toBe('deep');
    });

    it('forwards the exact selected Trace decisions into the agent input', () => {
        const traceDecisions = [
            {
                type: 'tradeoff',
                decision: 'Keep retries bounded to one attempt.',
                scope: ['src/payments'],
            },
        ];

        const input = buildOrchestratorInput(
            makeContext({ traceDecisions }),
            computed,
        );

        expect(input.traceDecisions).toBe(traceDecisions);
    });

    it('forwards the exact previous review decisions into the agent input (issue #1313)', () => {
        const previousDecisions = [
            {
                suggestionId: 'sug-1',
                relevantFile: 'src/payments/index.ts',
                suggestionContent: 'Use const instead of let.',
                label: 'bug',
                outcome: 'implemented' as const,
                decidedAt: '2026-01-01T00:00:00.000Z',
            },
        ];

        const input = buildOrchestratorInput(
            makeContext({ previousDecisions }),
            computed,
        );

        expect(input.previousDecisions).toBe(previousDecisions);
    });

    it('defaults reviewMode to normal when unset', () => {
        expect(
            buildOrchestratorInput(makeContext(), computed).reviewMode,
        ).toBe('normal');
    });

    it('passes the stage-computed locals through unchanged', () => {
        const input = buildOrchestratorInput(makeContext(), {
            ...computed,
            callGraph: '<CallGraph>x</CallGraph>',
            prNumber: 42,
        });
        expect(input.callGraph).toBe('<CallGraph>x</CallGraph>');
        expect(input.prNumber).toBe(42);
    });

    it('prefers stage-computed kodyRules (summary-swapped) over the raw config rules', () => {
        const configRules = [{ uuid: 'r1', rule: 'full long text' }];
        const swappedRules = [
            { uuid: 'r1', rule: 'WHAT TO VALIDATE:\n- condition' },
        ];
        const input = buildOrchestratorInput(
            makeContext({ codeReviewConfig: { kodyRules: configRules } }),
            { ...computed, kodyRules: swappedRules as any },
        );
        expect(input.kodyRules).toBe(swappedRules);
    });

    it('falls back to the config kodyRules when the stage computes none', () => {
        const configRules = [{ uuid: 'r1', rule: 'full long text' }];
        const input = buildOrchestratorInput(
            makeContext({ codeReviewConfig: { kodyRules: configRules } }),
            computed,
        );
        expect(input.kodyRules).toBe(configRules);
    });

    // ── repository-lookup capability (issue #1826, KRC-01) ──────────────────
    // The signal exists on the sandbox handle (`type`) and was discarded here.
    // remoteCommands cannot carry it: the null sandbox implements grep/read and
    // answers '' successfully, so `remoteCommands !== undefined` is true even
    // when there is nothing to look at.
    describe('repoLookup — the capability signal derived from the sandbox handle', () => {
        it('reports available for a real sandbox handle', () => {
            const input = buildOrchestratorInput(
                makeContext({
                    sandboxHandle: {
                        type: 'e2b',
                        remoteCommands: {
                            grep: async () => '',
                            read: async () => '',
                            listDir: async () => '',
                        },
                    },
                }),
                computed,
            );
            expect(input.repoLookup?.available).toBe(true);
        });

        it('reports unavailable end to end for the NULL sandbox', () => {
            const input = buildOrchestratorInput(
                makeContext({ sandboxHandle: NULL_SANDBOX_INSTANCE }),
                computed,
            );
            expect(input.repoLookup?.available).toBe(false);
            expect(input.repoLookup?.unavailableReason).toBe('null sandbox');
            // remoteCommands is NOT undefined here — that is exactly why it
            // could never have been the capability signal.
            expect(input.remoteCommands).toBeDefined();
        });

        it('reports unavailable when there is no sandbox at all (trial flow)', () => {
            const input = buildOrchestratorInput(makeContext(), computed);
            expect(input.repoLookup?.available).toBe(false);
            expect(input.repoLookup?.unavailableReason).toBe(
                'no sandbox handle',
            );
        });

        it('is always populated, so an absent field never has to be interpreted', () => {
            expect(
                buildOrchestratorInput(makeContext(), computed).repoLookup,
            ).toBeDefined();
        });

        it('an unavailable lookup raises from grep instead of answering empty', async () => {
            const input = buildOrchestratorInput(
                makeContext({ sandboxHandle: NULL_SANDBOX_INSTANCE }),
                computed,
            );
            await expect(input.repoLookup!.grep('formatDate')).rejects.toThrow(
                /repo lookup unavailable/,
            );
        });
    });
});
