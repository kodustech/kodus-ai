import type {
    UltraModel,
    UltraReviewState,
} from '@libs/code-review/domain/ultra-review-state';
import type { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import type {
    ReviewPass,
    ReviewPassCollected,
} from '@libs/code-review/pipeline/stages/agent-review.stage';

import {
    executeUltraReview,
    ULTRA_REVIEW_DEGRADED_REASON,
    type UltraReviewHost,
} from './ultra-review.executor';

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

interface Fixture {
    passes: Record<string, ReviewPassCollected | 'throw'>;
    merge?: Record<string, 'ok' | 'fail' | 'throw'>;
    context?: Partial<CodeReviewPipelineContext>;
    state?: Partial<UltraReviewState>;
}

function setup(fx: Fixture) {
    const calls = {
        passes: [] as Array<{
            scope?: string;
            model?: string;
            sandbox?: string;
        }>,
        sandboxes: [] as string[],
        released: [] as string[],
        merges: [] as string[],
        published: undefined as any,
        timeline: [] as any[],
        crossDedup: undefined as any,
    };
    const baseCleanup = jest.fn(async () => {
        calls.released.push('base');
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
        sandboxHandle: { cleanup: baseCleanup },
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
            });
            const plan = fx.passes[key];
            if (plan === 'throw') throw new Error(`${key} threw`);
            if (plan) pass.collect?.(plan);
            return {
                ...ctx,
                ...(pass.model &&
                    plan &&
                    !plan.completion.completed && {
                        lastReviewError: { category: 'auth', model: key },
                    }),
            } as any;
        },
        acquireRunSandbox: async (_ctx, suffix) => {
            calls.sandboxes.push(suffix);
            return {
                id: suffix,
                cleanup: async () => {
                    calls.released.push(suffix);
                },
            } as any;
        },
        runContext: (ctx, m, sandbox) =>
            ({ ...ctx, sandboxHandle: sandbox, model: m.modelId }) as any,
        update: (ctx, recipe) => {
            const draft = structuredClone({
                ...ctx,
                sandboxHandle: undefined,
                ultra: undefined,
            }) as any;
            draft.ultra = ctx.ultra;
            recipe(draft);
            return draft;
        },
        mergeFindings: async (findings, _pr, slot) => {
            calls.merges.push(slot.model);
            const plan = fx.merge?.[slot.model] ?? 'ok';
            if (plan === 'throw') throw new Error('merge threw');
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
        crossDedupStreams: async (nonRules, rules) => {
            calls.crossDedup = { nonRules, rules };
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
    it('runs each model natively in its own sandbox, the rules once, then merges and publishes', async () => {
        const { calls, context, host } = setup({
            passes: {
                a: collected(['a1', 'a2']),
                b: collected(['b1']),
                c: collected(['c3']),
                auxiliary: collected(['rule1']),
            },
        });

        const out = await executeUltraReview(context, host);

        const native = calls.passes.filter((p) => p.scope === 'native');
        expect(native.map((p) => [p.model, p.sandbox])).toEqual([
            ['a', 'ultra-1'],
            ['b', 'ultra-2'],
            ['c', 'ultra-3'],
        ]);
        expect(
            calls.passes.filter((p) => p.scope === 'auxiliary'),
        ).toHaveLength(1);
        // Each run's sandbox is released, and the PR's own once the rules ran.
        expect(calls.released.sort()).toEqual(
            ['base', 'ultra-1', 'ultra-2', 'ultra-3'].sort(),
        );
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
        await executeUltraReview(context, host);
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
        const out = await executeUltraReview(context, host);
        expect(calls.sandboxes).toContain('ultra-fallback');
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
        const out = await executeUltraReview(context, host);
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
        const out = await executeUltraReview(context, host);
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
        const out = await executeUltraReview(context, host);
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
        const out = await executeUltraReview(context, host);
        expect(out.ultra?.outcome).toBe('failed');
        expect(out.errors?.[0]).toMatchObject({ severity: 'critical' });
        expect(out.lastReviewError).toBeDefined();
        expect(calls.published.deduped.map((f: any) => f.id)).toEqual([
            'rule1',
        ]);
        // Every sandbox released, the thrown run's included.
        expect(calls.released).toEqual(
            expect.arrayContaining([
                'ultra-1',
                'ultra-2',
                'ultra-3',
                'ultra-fallback',
            ]),
        );
    });

    it('with only ignored files changed, runs the single review (the custom agents) instead', async () => {
        const { calls, context, host } = setup({
            passes: {},
            context: { changedFiles: [] },
        });
        await executeUltraReview(context, host);
        expect(calls.passes).toEqual([
            { scope: undefined, model: undefined, sandbox: undefined },
        ]);
    });
});
