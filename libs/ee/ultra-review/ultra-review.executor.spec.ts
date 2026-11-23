import type {
    UltraModel,
    UltraReviewState,
} from '@libs/code-review/domain/ultra-review-state';
import type { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import type {
    ReviewPass,
    ReviewPassCollected,
} from '@libs/code-review/pipeline/stages/agent-review.stage';

import { OTHER_LOCATIONS_HEADING } from '@libs/code-review/infrastructure/agents/engine/kody-rules-merge';

import {
    executeUltraReview,
    ULTRA_REVIEW_DEGRADED_REASON,
    ULTRA_REVIEW_LIMITS,
    type UltraReviewHost,
    type UltraReviewLimits,
} from './ultra-review.executor';

// Every case runs on these; a deadline case shortens one.
const LIMITS: UltraReviewLimits = {
    runDeadlineMs: 200,
    runGraceMs: 200,
    runsWindowMs: 2_000,
    runsEndFromJobStartMs: 2_000,
    fallbackMinMs: 50,
    mergeDeadlineMs: 200,
    crossDedupDeadlineMs: 200,
};

const model = (
    position: UltraModel['position'],
    modelId: string,
): UltraModel => ({
    position,
    modelId,
    modelName: `p:${modelId}`,
    slot: { provider: 'openai', apiKey: 'x', model: modelId } as any,
});

const finding = (id: string, label = 'bug') => ({
    id,
    label,
    relevantFile: 'a.ts',
    suggestionContent: id,
});

const collected = (
    ids: string[],
    completed = true,
    extra: Partial<ReviewPassCollected> = {},
): ReviewPassCollected => ({
    findings: ids.map((id) =>
        finding(id, id.startsWith('rule') ? 'kody_rules' : 'bug'),
    ),
    discarded: [],
    mergedInDedup: [],
    completion: completed
        ? { completed: true }
        : { completed: false, failureReason: 'The key is invalid.' },
    ...extra,
});

/**
 * 'hang' never returns; 'until-stopped' returns these findings as completed
 * once its review loop is stopped.
 */
type PassPlan =
    | ReviewPassCollected
    | 'throw'
    | 'hang'
    | { untilStopped: ReviewPassCollected }
    /** The loop ends in time; the later steps take `ms` more. */
    | { slowAfterLoop: number; result: ReviewPassCollected }
    /** Blocks the event loop for `ms` (sync work), then returns. */
    | { syncWorkMs: number; result: ReviewPassCollected };

interface Fixture {
    passes: Record<string, PassPlan>;
    merge?: Record<string, 'ok' | 'fail' | 'throw' | 'hang'>;
    crossDedupHangs?: boolean;
    context?: Partial<CodeReviewPipelineContext>;
    state?: Partial<UltraReviewState>;
}

function setup(fx: Fixture) {
    const calls = {
        passes: [] as Array<{
            scope?: string;
            model?: string;
            sandbox?: string;
            superseded?: boolean;
        }>,
        released: [] as string[],
        /** Passes ending and the PR's release, in order. */
        order: [] as string[],
        merges: [] as string[],
        mergeSignals: {} as Record<string, AbortSignal | undefined>,
        crossDedupSignal: undefined as AbortSignal | undefined,
        published: undefined as any,
        timeline: [] as any[],
        crossDedup: undefined as any,
        abandonSignals: {} as Record<string, AbortSignal | undefined>,
    };
    const baseCleanup = jest.fn(async () => {
        calls.released.push('base');
        calls.order.push('base');
    });
    const state: UltraReviewState = {
        models: [model(1, 'a'), model(2, 'b'), model(3, 'c')],
        fallback: model('fallback', 'f'),
        mergeModel: model(2, 'b'),
        ...fx.state,
    };
    const context = {
        organizationAndTeamData: { organizationId: 'org', teamId: 'team' },
        pullRequest: { number: 7 },
        repository: { id: 'r', name: 'repo' },
        changedFiles: [{ filename: 'a.ts' }],
        codeReviewConfig: { kodyRules: [{ uuid: 'r1' }] },
        sandboxHandle: { id: 'pr', cleanup: baseCleanup },
        pipelineMetadata: { pipelineId: 'Pipe-42' },
        ultra: state,
        errors: [],
        ...fx.context,
    } as unknown as CodeReviewPipelineContext;

    const host: UltraReviewHost = {
        reviewPass: async (ctx, pass: ReviewPass) => {
            const key = pass.model?.modelId ?? pass.scope ?? 'all';
            calls.passes.push({
                scope: pass.scope,
                model: pass.model?.modelId,
                sandbox: (ctx as any).sandboxHandle?.id,
                ...((ctx as any).sandboxSuperseded && { superseded: true }),
            });
            calls.abandonSignals[key] = pass.abandoned;
            const plan = fx.passes[key];
            if (plan === 'throw') throw new Error(`${key} threw`);
            if (plan === 'hang') {
                await new Promise(() => undefined);
                return ctx;
            }
            let result: ReviewPassCollected | undefined;
            if (plan && 'untilStopped' in plan) {
                const signal = ctx.parentSignal!;
                await new Promise((resolve) =>
                    signal.addEventListener('abort', resolve),
                );
                pass.onLoopEnd?.();
                result = plan.untilStopped;
            } else if (plan && 'syncWorkMs' in plan) {
                const until = Date.now() + plan.syncWorkMs;
                while (Date.now() < until) {
                    // Holds the event loop, as a slow synchronous step does.
                }
                pass.onLoopEnd?.();
                result = plan.result;
            } else if (plan && 'slowAfterLoop' in plan) {
                pass.onLoopEnd?.();
                await new Promise((r) => setTimeout(r, plan.slowAfterLoop));
                result = plan.result;
            } else {
                pass.onLoopEnd?.();
                result = plan as ReviewPassCollected | undefined;
            }
            if (result) pass.collect?.(result);
            calls.order.push(`done:${key}`);
            return {
                ...ctx,
                ...(pass.model &&
                    result &&
                    !result.completion.completed && {
                        lastReviewError: { category: 'auth', model: key },
                    }),
            } as any;
        },
        runContext: (ctx, m, sandbox, signal) =>
            ({
                ...ctx,
                sandboxHandle: sandbox,
                model: m.modelId,
                parentSignal: signal,
            }) as any,
        update: (ctx, recipe) => {
            const draft = structuredClone({
                ...ctx,
                sandboxHandle: undefined,
                ultra: undefined,
                parentSignal: undefined,
            }) as any;
            draft.ultra = ctx.ultra;
            draft.parentSignal = ctx.parentSignal;
            recipe(draft);
            return draft;
        },
        mergeFindings: async (findings, _pr, slot, _ctx, signal) => {
            calls.merges.push(slot.model);
            calls.mergeSignals[slot.model] = signal;
            // As the dedup does before each model call.
            signal?.throwIfAborted();
            const plan = fx.merge?.[slot.model] ?? 'ok';
            if (plan === 'throw') throw new Error('merge threw');
            if (plan === 'hang') return new Promise(() => undefined);
            if (plan === 'fail') {
                return {
                    suggestions: findings,
                    trace: {
                        status: 'failed-keep-all',
                        errorMessage: '503',
                    } as any,
                };
            }
            // Keeps the first finding of each id prefix: a1/b1 duplicates.
            const seen = new Set<string>();
            const kept = findings.filter((f) => {
                const k = String(f.id).replace(/^[abcf]/, 'x');
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
            });
            return { suggestions: kept, trace: { status: 'success' } as any };
        },
        crossDedupStreams: async (nonRules, rules, _pr, _ctx, signal) => {
            calls.crossDedup = { nonRules, rules };
            calls.crossDedupSignal = signal;
            if (fx.crossDedupHangs) return new Promise(() => undefined);
            return [...nonRules, ...rules];
        },
        customAgentsById: async () => new Map(),
        publishFindings: (ctx, input) => {
            calls.published = input;
            return ctx;
        },
        recordTimeline: async (_ctx, entry) => {
            calls.timeline.push(entry);
        },
    };
    return { calls, context, host, baseCleanup };
}

describe('executeUltraReview', () => {
    it("runs each model natively on the PR's sandbox, the rules once, then merges and publishes", async () => {
        const { calls, context, host } = setup({
            passes: {
                a: collected(['a1', 'a2']),
                b: collected(['b1']),
                c: collected(['c3']),
                auxiliary: collected(['rule1']),
            },
        });

        const out = await executeUltraReview(context, host, LIMITS);

        const native = calls.passes.filter((p) => p.scope === 'native');
        expect(native.map((p) => [p.model, p.sandbox])).toEqual([
            ['a', 'pr'],
            ['b', 'pr'],
            ['c', 'pr'],
        ]);
        expect(
            calls.passes.filter((p) => p.scope === 'auxiliary'),
        ).toHaveLength(1);
        // Only the PR's own lease is released: the runs take none.
        expect(calls.released).toEqual(['base']);
        // The merge runs on the merge model only, over every model's list.
        expect(calls.merges).toEqual(['b']);
        expect(calls.crossDedup.rules.map((r: any) => r.id)).toEqual(['rule1']);
        expect(calls.published.deduped.map((f: any) => f.id)).toEqual([
            'a1',
            'a2',
            'c3',
            'rule1',
        ]);
        expect(out.ultra?.outcome).toBe('success');
        expect(out.ultra?.merge).toMatchObject({
            status: 'success',
            modelName: 'p:b',
            inputCount: 4,
            outputCount: 3,
        });
        expect(out.errors ?? []).toHaveLength(0);
        expect(calls.timeline[0].label).toBe(
            'Cross-model merge · p:b — 4 → 3 comments',
        );
    });

    it('skips the auxiliary pass when there are no rules, custom agents or analyzer findings', async () => {
        const { calls, context, host, baseCleanup } = setup({
            passes: {
                a: collected(['a1']),
                b: collected(['b1']),
                c: collected(['c1']),
            },
            context: { codeReviewConfig: {} as any },
        });
        await executeUltraReview(context, host, LIMITS);
        expect(calls.passes.some((p) => p.scope === 'auxiliary')).toBe(false);
        expect(baseCleanup).toHaveBeenCalledTimes(1);
    });

    it('a model fails and the fallback completes: success, its partial findings dropped', async () => {
        const { calls, context, host } = setup({
            passes: {
                a: collected(['a1']),
                b: collected(['b9'], false),
                c: collected(['c2']),
                f: collected(['f3']),
                auxiliary: collected([]),
            },
        });
        const out = await executeUltraReview(context, host, LIMITS);
        expect(calls.passes.map((p) => p.model)).toContain('f');
        expect(out.ultra?.outcome).toBe('success');
        expect(out.ultra?.runs?.find((r) => r.modelId === 'b')).toMatchObject({
            status: 'failed',
            replacedBy: 'f',
        });
        expect(calls.published.deduped.map((f: any) => f.id)).not.toContain(
            'b9',
        );
        expect(out.errors ?? []).toHaveLength(0);
    });

    it('the merge model fails: the fallback merges', async () => {
        const { calls, context, host } = setup({
            passes: {
                a: collected(['a1']),
                b: collected(['b1']),
                c: collected(['c2']),
                auxiliary: collected([]),
            },
            merge: { b: 'fail' },
        });
        const out = await executeUltraReview(context, host, LIMITS);
        expect(calls.merges).toEqual(['b', 'f']);
        expect(out.ultra?.merge).toMatchObject({
            status: 'fallback',
            modelName: 'p:f',
        });
        expect(out.ultra?.outcome).toBe('success');
    });

    it('the merge model and the fallback fail: published unmerged, degraded, approval held', async () => {
        const { calls, context, host } = setup({
            passes: {
                a: collected(['a1']),
                b: collected(['b1']),
                c: collected(['c2']),
                auxiliary: collected([]),
            },
            merge: { b: 'throw', f: 'fail' },
        });
        const out = await executeUltraReview(context, host, LIMITS);
        expect(out.ultra?.merge?.status).toBe('failed');
        expect(calls.published.deduped).toHaveLength(3);
        expect(out.ultra?.outcome).toBe('degraded');
        expect(out.errors).toEqual([
            expect.objectContaining({
                severity: 'partial',
                metadata: expect.objectContaining({
                    reason: ULTRA_REVIEW_DEGRADED_REASON,
                }),
            }),
        ]);
        expect(calls.timeline[0].label).toMatch(
            /failed, 3 comments posted unmerged/,
        );
        // The provider's text (here "503") is not stored.
        expect(out.ultra?.merge?.errorMessage).toBe(
            'No merge model returned a merge.',
        );
    });

    it('no fallback set and a model fails: degraded, its partial findings published', async () => {
        const { calls, context, host } = setup({
            passes: {
                a: collected(['a1']),
                b: collected(['b9'], false),
                c: collected(['c2']),
                auxiliary: collected([]),
            },
            state: { fallback: undefined },
        });
        const out = await executeUltraReview(context, host, LIMITS);
        expect(out.ultra?.outcome).toBe('degraded');
        expect(calls.published.deduped.map((f: any) => f.id)).toContain('b9');
        expect(out.errors?.[0]?.severity).toBe('partial');
    });

    it("no model completes: the review fails with the first model's error, and the rules still post", async () => {
        const { calls, context, host } = setup({
            passes: {
                a: collected([], false),
                b: collected([], false),
                c: 'throw',
                f: collected([], false),
                auxiliary: collected(['rule1']),
            },
        });
        const out = await executeUltraReview(context, host, LIMITS);
        expect(out.ultra?.outcome).toBe('failed');
        expect(out.errors?.[0]).toMatchObject({ severity: 'critical' });
        expect(out.lastReviewError).toBeDefined();
        expect(calls.published.deduped.map((f: any) => f.id)).toEqual([
            'rule1',
        ]);
        // The PR's sandbox is released though a run threw.
        expect(calls.released).toEqual(['base']);
    });

    it('with only ignored files changed, runs the single review (the custom agents) instead', async () => {
        const { calls, context, host } = setup({
            passes: {},
            context: { changedFiles: [] },
        });
        await executeUltraReview(context, host, LIMITS);
        expect(calls.passes).toEqual([
            { scope: undefined, model: undefined, sandbox: 'pr' },
        ]);
    });

    describe('time limits', () => {
        it('a model that never returns is left behind: the other two still post, degraded', async () => {
            const { calls, context, host } = setup({
                passes: {
                    a: collected(['a1']),
                    b: 'hang',
                    c: collected(['c2']),
                    auxiliary: collected(['rule1']),
                },
                state: { fallback: undefined },
            });
            const out = await executeUltraReview(context, host, LIMITS);
            expect(calls.published.deduped.map((f: any) => f.id)).toEqual([
                'a1',
                'c2',
                'rule1',
            ]);
            expect(out.ultra?.outcome).toBe('degraded');
            expect(
                out.ultra?.runs?.find((r) => r.modelId === 'b'),
            ).toMatchObject({
                status: 'failed',
                failureReason: expect.stringMatching(/did not finish within/),
            });
            // The PR's sandbox is not held for the run left behind.
            expect(calls.released).toEqual(['base']);
        });

        it('a model whose loop is stopped by the deadline failed, and the fallback replaces it', async () => {
            const { calls, context, host } = setup({
                passes: {
                    a: collected(['a1']),
                    b: { untilStopped: collected(['b9']) },
                    c: collected(['c2']),
                    f: collected(['f3']),
                    auxiliary: collected([]),
                },
            });
            const out = await executeUltraReview(context, host, LIMITS);
            expect(
                out.ultra?.runs?.find((r) => r.modelId === 'b'),
            ).toMatchObject({
                status: 'failed',
                failureReason: expect.stringMatching(/stopped after/),
                replacedBy: 'f',
            });
            expect(out.ultra?.outcome).toBe('success');
            expect(calls.published.deduped.map((f: any) => f.id)).toEqual([
                'a1',
                'c2',
                'f3',
            ]);
        });

        it('a deadline that fires after the loop ended, during the later steps, does not fail the run', async () => {
            const { context, host } = setup({
                passes: {
                    a: collected(['a1']),
                    b: { slowAfterLoop: 300, result: collected(['b1']) },
                    c: collected(['c2']),
                    auxiliary: collected([]),
                },
            });
            const out = await executeUltraReview(context, host, LIMITS);
            expect(
                out.ultra?.runs?.find((r) => r.modelId === 'b')?.status,
            ).toBe('completed');
            expect(out.ultra?.outcome).toBe('success');
        });

        it('with the production limits, a model that hangs still gets the fallback, with lag in the review', async () => {
            // The production limits at 1 minute = 10 ms.
            const scaled = Object.fromEntries(
                Object.entries(ULTRA_REVIEW_LIMITS).map(([k, v]) => [
                    k,
                    (v as number) / 6_000,
                ]),
            ) as unknown as UltraReviewLimits;
            const { calls, context, host } = setup({
                passes: {
                    a: collected(['a1']),
                    b: 'hang',
                    c: collected(['c2']),
                    f: collected(['f3']),
                    // Three scaled minutes of synchronous work in Kody Rules.
                    auxiliary: { syncWorkMs: 30, result: collected([]) },
                },
                context: { pipelineStartedAt: Date.now() } as any,
            });
            const out = await executeUltraReview(context, host, scaled);
            expect(calls.passes.map((p) => p.model)).toContain('f');
            expect(out.ultra?.outcome).toBe('success');
            // The run left behind is told to stop its later steps.
            expect(calls.abandonSignals.b?.aborted).toBe(true);
        });

        it('the runs end by the budget counted from the job start, not this step', async () => {
            const { context, host } = setup({
                passes: {
                    a: collected(['a1']),
                    b: { untilStopped: collected(['b9']) },
                    c: collected(['c2']),
                    auxiliary: collected([]),
                },
                state: { fallback: undefined },
                // The job started 1.7 s ago: 300 ms of its 2 s budget left.
                context: { pipelineStartedAt: Date.now() - 1_700 } as any,
            });
            const out = await executeUltraReview(context, host, LIMITS);
            const b = out.ultra?.runs?.find((r) => r.modelId === 'b');
            expect(b?.status).toBe('failed');
            // Stopped at 300 - 200 (grace) = 100 ms, not at the 200 ms deadline.
            expect(b?.durationMs).toBeLessThan(180);
        });

        it('a dedup against Kody Rules that never answers lets the comments go out without it', async () => {
            const { calls, context, host } = setup({
                passes: {
                    a: collected(['a1']),
                    b: collected(['b1']),
                    c: collected(['c2']),
                    auxiliary: collected(['rule1']),
                },
                crossDedupHangs: true,
            });
            const out = await executeUltraReview(context, host, LIMITS);
            expect(calls.published.deduped.map((f: any) => f.id)).toEqual([
                'a1',
                'c2',
                'rule1',
            ]);
            expect(out.ultra?.outcome).toBe('success');
            // The dedup left behind starts no further model call.
            expect(calls.crossDedupSignal?.aborted).toBe(true);
        });

        it('the fallback does not start without time left to review', async () => {
            const { calls, context, host } = setup({
                passes: {
                    a: collected(['a1']),
                    b: collected(['b9'], false),
                    c: collected(['c2']),
                    f: collected(['f3']),
                    auxiliary: collected([]),
                },
            });
            const out = await executeUltraReview(context, host, {
                ...LIMITS,
                fallbackMinMs: 10_000,
            });
            expect(calls.passes.map((p) => p.model)).not.toContain('f');
            expect(out.ultra?.outcome).toBe('degraded');
            // With no fallback run, the failed model's partial findings post.
            expect(calls.published.deduped.map((f: any) => f.id)).toContain(
                'b9',
            );
        });

        it('a merge that never answers gives way to the fallback', async () => {
            const { calls, context, host } = setup({
                passes: {
                    a: collected(['a1']),
                    b: collected(['b1']),
                    c: collected(['c2']),
                    auxiliary: collected([]),
                },
                merge: { b: 'hang' },
            });
            const out = await executeUltraReview(context, host, LIMITS);
            expect(calls.merges).toEqual(['b', 'f']);
            expect(out.ultra?.merge).toMatchObject({
                status: 'fallback',
                modelName: 'p:f',
            });
            // The merge left behind starts no further model call.
            expect(calls.mergeSignals.b?.aborted).toBe(true);
        });

        it('Kody Rules that never return do not hold the models back', async () => {
            const { calls, context, host } = setup({
                passes: {
                    a: collected(['a1']),
                    b: collected(['b1']),
                    c: collected(['c2']),
                    auxiliary: 'hang',
                },
            });
            const out = await executeUltraReview(context, host, {
                ...LIMITS,
                runsWindowMs: 300,
            });
            expect(calls.published.deduped.map((f: any) => f.id)).toEqual([
                'a1',
                'c2',
            ]);
            // The review is incomplete without them: it is degraded, so
            // the notice says why approval is held.
            expect(out.ultra?.outcome).toBe('degraded');
            expect(out.ultra?.auxiliaryMissed).toBe(true);
            expect(calls.released).toContain('base');
            expect(out.errors).toEqual([
                expect.objectContaining({
                    substage: 'ultra',
                    severity: 'partial',
                    error: expect.objectContaining({
                        message: expect.stringContaining(
                            'Kody Rules and custom agents did not finish in time',
                        ),
                    }),
                }),
            ]);
        });

        it('Kody Rules stopped at their window but back in time leave the merge its own deadline', async () => {
            const { calls, context, host } = setup({
                passes: {
                    a: collected(['a1']),
                    b: collected(['b1']),
                    c: collected(['c2']),
                    auxiliary: { untilStopped: collected(['rule1']) },
                },
            });
            const out = await executeUltraReview(context, host, {
                ...LIMITS,
                runDeadlineMs: 100,
            });
            expect(out.ultra?.merge?.status).toBe('success');
            expect(calls.merges).toEqual(['b']);
        });

        it('a stage that starts with no time left in the job starts no review', async () => {
            const { calls, context, host } = setup({
                passes: {
                    a: collected(['a1']),
                    b: collected(['b1']),
                    c: collected(['c2']),
                    auxiliary: collected(['rule1']),
                },
                state: { fallback: undefined },
                // The job's 2 s budget ran out before this step.
                context: { pipelineStartedAt: Date.now() - 2_500 } as any,
            });
            const out = await executeUltraReview(context, host, LIMITS);
            expect(calls.passes).toEqual([]);
            expect(out.ultra?.outcome).toBe('failed');
            for (const run of out.ultra?.runs ?? []) {
                expect(run.failureReason).toBe(
                    'No time was left in the job for its review.',
                );
            }
            expect(out.ultra?.auxiliaryMissed).toBe(true);
            expect(out.errors).toEqual([
                expect.objectContaining({
                    substage: 'ultra',
                    severity: 'critical',
                }),
            ]);
        });
    });

    describe('sandboxes', () => {
        it("every run reviews on the PR's sandbox and takes no lease of its own", async () => {
            const { calls, context, host } = setup({
                passes: {
                    a: collected(['a1']),
                    b: collected(['b9'], false),
                    c: collected(['c2']),
                    f: collected(['f3']),
                    auxiliary: collected([]),
                },
            });
            await executeUltraReview(context, host, LIMITS);
            expect(
                calls.passes
                    .filter((p) => p.scope === 'native')
                    .map((p) => [p.model, p.sandbox]),
            ).toEqual([
                ['a', 'pr'],
                ['b', 'pr'],
                ['c', 'pr'],
                ['f', 'pr'],
            ]);
            expect(calls.released).toEqual(['base']);
        });

        it("releases the PR's lease only after every run, the fallback's included", async () => {
            const { calls, context, host } = setup({
                passes: {
                    a: collected(['a1']),
                    b: collected(['b9'], false),
                    c: collected(['c2']),
                    f: { slowAfterLoop: 50, result: collected(['f3']) },
                    auxiliary: collected([]),
                },
            });
            await executeUltraReview(context, host, LIMITS);
            expect(calls.order.indexOf('done:f')).toBeGreaterThan(-1);
            expect(calls.order[calls.order.length - 1]).toBe('base');
        });

        it('a review a later push superseded runs with no sandbox, still moot, and no run fails for it', async () => {
            const { calls, context, host } = setup({
                passes: {
                    a: collected(['a1']),
                    b: collected(['b1']),
                    c: collected(['c2']),
                    auxiliary: collected([]),
                },
                context: {
                    sandboxSuperseded: true,
                    sandboxHandle: undefined,
                } as any,
            });
            const out = await executeUltraReview(context, host, LIMITS);
            expect(
                calls.passes
                    .filter((p) => p.scope === 'native')
                    .map((p) => [p.model, p.sandbox, p.superseded]),
            ).toEqual([
                ['a', undefined, true],
                ['b', undefined, true],
                ['c', undefined, true],
            ]);
            expect(out.ultra?.outcome).toBe('success');
            expect(out.errors).toEqual([]);
        });

        it('with no sandbox for the PR (none configured), the runs complete', async () => {
            const { context, host } = setup({
                passes: {
                    a: collected(['a1']),
                    b: collected(['b1']),
                    c: collected(['c2']),
                    auxiliary: collected([]),
                },
                context: { sandboxHandle: undefined } as any,
            });
            const out = await executeUltraReview(context, host, LIMITS);
            expect(out.ultra?.outcome).toBe('success');
        });
    });

    describe('merge', () => {
        it('with one list alone, nothing is merged and no model is called', async () => {
            const { calls, context, host } = setup({
                passes: {
                    a: collected(['a1', 'a2']),
                    b: 'throw',
                    c: 'throw',
                    f: 'throw',
                    auxiliary: collected(['rule1']),
                },
            });
            const out = await executeUltraReview(context, host, LIMITS);
            expect(calls.merges).toEqual([]);
            expect(out.ultra?.merge?.status).toBe('skipped');
            // No model is named for a merge that never ran.
            expect(out.ultra?.merge?.modelName).toBeUndefined();
            expect(calls.timeline[0].label).toBe(
                'Cross-model merge — nothing to merge, 2 comments',
            );
            expect(calls.published.deduped.map((f: any) => f.id)).toEqual([
                'a1',
                'a2',
                'rule1',
            ]);
        });

        it('three models with one finding between them: a success, with no merge model called or named', async () => {
            const { calls, context, host } = setup({
                passes: {
                    a: collected(['a1']),
                    b: collected([]),
                    c: collected([]),
                    auxiliary: collected([]),
                },
            });
            const out = await executeUltraReview(context, host, LIMITS);
            expect(calls.merges).toEqual([]);
            expect(out.ultra?.merge).toEqual(
                expect.objectContaining({ status: 'success', inputCount: 1 }),
            );
            expect(out.ultra?.merge?.modelName).toBeUndefined();
            expect(out.ultra?.outcome).toBe('success');
        });

        it("one model's list and the custom agents' are merged", async () => {
            const { calls, context, host } = setup({
                passes: {
                    a: collected(['a1']),
                    b: 'throw',
                    c: 'throw',
                    f: 'throw',
                    auxiliary: collected(['custom1']),
                },
            });
            await executeUltraReview(context, host, LIMITS);
            expect(calls.merges).toEqual(['b']);
        });

        it('lists the places a kept comment absorbed from the other models, once', async () => {
            const kept = {
                ...finding('a1'),
                suggestionContent: `a1\n\n${OTHER_LOCATIONS_HEADING}\n- \`a.ts:9-9\``,
                fullExplanation: `why\n\n${OTHER_LOCATIONS_HEADING}\n- \`a.ts:9-9\``,
                llmPrompt: `fix\n\n${OTHER_LOCATIONS_HEADING}\n- \`a.ts:9-9\``,
                alsoFoundIn: ['a.ts:9-9'],
            };
            const { calls, context, host } = setup({
                passes: {
                    a: { ...collected([]), findings: [kept] },
                    b: collected(['b1']),
                    c: collected(['c2']),
                    auxiliary: collected([]),
                },
            });
            host.mergeFindings = async (findings) => {
                const a1 = findings.find((f) => f.id === 'a1')!;
                a1.alsoFoundIn = [...(a1.alsoFoundIn ?? []), 'b.ts:3-4'];
                return {
                    suggestions: findings.filter((f) => f.id !== 'b1'),
                    trace: { status: 'success' } as any,
                };
            };
            await executeUltraReview(context, host, LIMITS);
            const out = calls.published.deduped.find((f: any) => f.id === 'a1');
            const section = `${OTHER_LOCATIONS_HEADING}\n- \`a.ts:9-9\`\n- \`b.ts:3-4\``;
            for (const field of [
                'suggestionContent',
                'fullExplanation',
                'llmPrompt',
            ]) {
                expect(out[field]).toContain(section);
                expect(out[field].split(OTHER_LOCATIONS_HEADING)).toHaveLength(
                    2,
                );
            }
        });
    });

    it('a comment the merge rebuilt lists the places it absorbed too', async () => {
        const { calls, context, host } = setup({
            passes: {
                a: collected(['a1']),
                b: collected(['b1']),
                c: collected(['c2']),
                auxiliary: collected([]),
            },
        });
        host.mergeFindings = async (findings) => ({
            suggestions: findings
                .filter((f) => f.id !== 'b1')
                .map((f) =>
                    f.id === 'a1' ? { ...f, alsoFoundIn: ['b.ts:3-4'] } : f,
                ),
            trace: { status: 'success' } as any,
        });
        await executeUltraReview(context, host, LIMITS);
        const out = calls.published.deduped.find((f: any) => f.id === 'a1');
        expect(out.suggestionContent).toContain(
            `${OTHER_LOCATIONS_HEADING}\n- \`b.ts:3-4\``,
        );
    });

    it("a failed review carries the models' error, not one the Kody Rules left", async () => {
        const { context, host } = setup({
            passes: {
                a: collected([], false),
                b: collected([], false),
                c: collected([], false),
                f: collected([], false),
                auxiliary: collected(['rule1']),
            },
        });
        const reviewPass = host.reviewPass;
        host.reviewPass = async (ctx, pass) => {
            const out = await reviewPass(ctx, pass);
            return pass.scope === 'auxiliary'
                ? ({
                      ...out,
                      lastReviewError: {
                          category: 'rate_limit',
                          model: 'rules',
                      },
                  } as any)
                : out;
        };
        const out = await executeUltraReview(context, host, LIMITS);
        expect(out.lastReviewError).toMatchObject({ model: 'a' });
    });
});
