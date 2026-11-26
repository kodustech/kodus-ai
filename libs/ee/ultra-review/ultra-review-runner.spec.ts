import type {
    UltraModel,
    UltraReviewState,
} from '@libs/code-review/domain/ultra-review-state';
import {
    runUltraModels,
    ultraReviewOutcome,
    type UltraModelRunResult,
} from './ultra-review-runner';

const model = (
    position: UltraModel['position'],
    modelId: string,
): UltraModel => ({
    position,
    modelId,
    modelName: `p:${modelId}`,
    slot: { provider: 'openai', apiKey: 'x', model: modelId } as any,
});

const trio = [model(1, 'a'), model(2, 'b'), model(3, 'c')];
const fb = model('fallback', 'f');

type Plan = Record<string, UltraModelRunResult<string[]> | 'throw'>;

/** Runs each model per `plan`; a model's failure resolves after `delays`. */
async function run(
    state: Pick<UltraReviewState, 'models' | 'unavailable' | 'fallback'>,
    plan: Plan,
    delays: Record<string, number> = {},
    fallbackAllowed?: () => boolean,
) {
    const started: string[] = [];
    const result = await runUltraModels<string[]>({
        state,
        fallbackAllowed,
        run: async (m) => {
            started.push(m.modelId);
            await new Promise((r) => setTimeout(r, delays[m.modelId] ?? 0));
            const p = plan[m.modelId];
            if (p === 'throw') throw new Error(`${m.modelId} blew up`);
            return p;
        },
    });
    return { ...result, started };
}

const ok = (id: string): UltraModelRunResult<string[]> => ({
    completed: true,
    output: [`${id}-finding`],
    findings: 1,
});
const fail = (id: string, partial = true): UltraModelRunResult<string[]> => ({
    completed: false,
    failureReason: `${id} failed`,
    ...(partial && { output: [`${id}-partial`] }),
});

describe('runUltraModels', () => {
    it('runs the three models and keeps every output when all complete', async () => {
        const r = await run(
            { models: trio, fallback: fb },
            { a: ok('a'), b: ok('b'), c: ok('c') },
        );
        expect(r.started).toEqual(['a', 'b', 'c']);
        expect(r.runs.map((x) => x.status)).toEqual([
            'completed',
            'completed',
            'completed',
        ]);
        expect(r.outputs.map((o) => o.output[0])).toEqual([
            'a-finding',
            'b-finding',
            'c-finding',
        ]);
    });

    it('one model fails: the fallback takes its place, and the partial output goes', async () => {
        const r = await run(
            { models: trio, fallback: fb },
            { a: ok('a'), b: fail('b'), c: ok('c'), f: ok('f') },
        );
        expect(r.started).toEqual(['a', 'b', 'c', 'f']);
        const b = r.runs.find((x) => x.modelId === 'b')!;
        expect(b).toMatchObject({ status: 'failed', replacedBy: 'f' });
        expect(r.runs.at(-1)).toMatchObject({
            position: 'fallback',
            status: 'completed',
        });
        expect(r.outputs.map((o) => o.output[0])).toEqual([
            'a-finding',
            'c-finding',
            'f-finding',
        ]);
        expect(
            ultraReviewOutcome(r.runs, {
                status: 'success',
                inputCount: 3,
                outputCount: 3,
            }),
        ).toBe('success');
    });

    it('two models fail: the fallback runs once, for the first to fail; the other is not replaced and keeps its partial output', async () => {
        const r = await run(
            { models: trio, fallback: fb },
            { a: fail('a'), b: fail('b'), c: ok('c'), f: ok('f') },
            { a: 5, b: 1 },
        );
        expect(r.started.filter((id) => id === 'f')).toHaveLength(1);
        expect(r.runs.find((x) => x.modelId === 'b')).toMatchObject({
            replacedBy: 'f',
        });
        expect(
            r.runs.find((x) => x.modelId === 'a')?.replacedBy,
        ).toBeUndefined();
        expect(r.outputs.map((o) => o.output[0]).sort()).toEqual([
            'a-partial',
            'c-finding',
            'f-finding',
        ]);
        expect(
            ultraReviewOutcome(r.runs, {
                status: 'success',
                inputCount: 3,
                outputCount: 3,
            }),
        ).toBe('degraded');
    });

    it('three models fail and the fallback fails too: every partial output stays, nothing completed', async () => {
        const r = await run(
            { models: trio, fallback: fb },
            { a: fail('a'), b: fail('b'), c: fail('c'), f: fail('f') },
        );
        expect(r.runs.filter((x) => x.status === 'failed')).toHaveLength(4);
        expect(r.outputs).toHaveLength(4);
        expect(ultraReviewOutcome(r.runs, undefined)).toBe('failed');
    });

    it("a model that throws is a failed run with no output, and the error's text stays out of its reason", async () => {
        const r = await run(
            { models: trio },
            { a: 'throw', b: ok('b'), c: ok('c') },
        );
        expect(r.runs[0]).toMatchObject({
            modelId: 'a',
            status: 'failed',
            failureReason: 'The review stopped on an internal error.',
        });
        expect(r.outputs).toHaveLength(2);
    });

    it('with no fallback set, a failed model is not replaced and its partial output stays', async () => {
        const r = await run(
            { models: trio },
            { a: ok('a'), b: fail('b'), c: ok('c') },
        );
        expect(r.started).toEqual(['a', 'b', 'c']);
        expect(r.runs[1].replacedBy).toBeUndefined();
        expect(r.outputs.map((o) => o.output[0])).toContain('b-partial');
        expect(
            ultraReviewOutcome(r.runs, {
                status: 'success',
                inputCount: 3,
                outputCount: 3,
            }),
        ).toBe('degraded');
    });

    it("a failed fallback leaves the failed model's partial output in", async () => {
        const r = await run(
            { models: trio, fallback: fb },
            { a: ok('a'), b: fail('b'), c: ok('c'), f: fail('f', false) },
        );
        expect(r.runs[1]).toMatchObject({ replacedBy: 'f' });
        expect(r.outputs.map((o) => o.output[0])).toEqual([
            'a-finding',
            'b-partial',
            'c-finding',
        ]);
    });

    it('a fallback that is one of the three never runs again: its review counts once for the first other model to fail', async () => {
        const inTrio = { ...model('fallback', 'c') };
        const r = await run(
            { models: trio, fallback: inTrio },
            { a: fail('a'), b: ok('b'), c: ok('c') },
        );
        expect(r.started).toEqual(['a', 'b', 'c']);
        expect(r.runs[0]).toMatchObject({
            replacedBy: 'c',
            reusedRun: true,
        });
        // Two distinct models completed: degraded.
        expect(
            ultraReviewOutcome(r.runs, {
                status: 'success',
                inputCount: 2,
                outputCount: 2,
            }),
        ).toBe('degraded');
        expect(r.outputs.map((o) => o.output[0])).toEqual([
            'b-finding',
            'c-finding',
        ]);
    });

    it('a fallback in the trio that fails after another model failed reused nothing', async () => {
        const inTrio = { ...model('fallback', 'c') };
        const r = await run(
            { models: trio, fallback: inTrio },
            { a: fail('a'), b: ok('b'), c: fail('c') },
            { a: 1, c: 20 },
        );
        expect(r.runs[0].replacedBy).toBeUndefined();
        expect(r.runs[0].reusedRun).toBeUndefined();
        // Nothing replaced it, so its partial output stays.
        expect(r.outputs.map((o) => o.output[0])).toContain('a-partial');
    });

    it('a fallback in the trio that fails itself replaces nothing', async () => {
        const inTrio = { ...model('fallback', 'c') };
        const r = await run(
            { models: trio, fallback: inTrio },
            { a: ok('a'), b: ok('b'), c: fail('c') },
        );
        expect(r.runs[2].replacedBy).toBeUndefined();
        expect(r.runs[2].reusedRun).toBeUndefined();
    });

    it('a model the config no longer resolves fails before anything runs, and the fallback takes its place', async () => {
        const r = await run(
            {
                models: [trio[0], trio[2]],
                unavailable: [
                    { position: 2, modelId: 'b', reason: 'Removed.' },
                ],
                fallback: fb,
            },
            { a: ok('a'), c: ok('c'), f: ok('f') },
        );
        expect(r.started).toEqual(['f', 'a', 'c']);
        expect(r.runs.find((x) => x.modelId === 'b')).toMatchObject({
            position: 2,
            status: 'failed',
            failureReason: 'Removed.',
            replacedBy: 'f',
        });
        expect(
            ultraReviewOutcome(r.runs, {
                status: 'success',
                inputCount: 3,
                outputCount: 3,
            }),
        ).toBe('success');
    });

    it('starts the fallback as soon as a model fails, without waiting for the others', async () => {
        const order: string[] = [];
        await runUltraModels<string[]>({
            state: { models: trio, fallback: fb },
            run: async (m) => {
                order.push(`start:${m.modelId}`);
                const delay = { a: 30, b: 1, c: 30, f: 1 }[m.modelId] ?? 0;
                await new Promise((r) => setTimeout(r, delay));
                order.push(`end:${m.modelId}`);
                return m.modelId === 'b' ? fail('b') : ok(m.modelId);
            },
        });
        // A missing entry is -1, before any index: each must be there.
        expect(order).toEqual(
            expect.arrayContaining(['start:f', 'end:a', 'end:c']),
        );
        expect(order.indexOf('start:f')).toBeLessThan(order.indexOf('end:a'));
        expect(order.indexOf('start:f')).toBeLessThan(order.indexOf('end:c'));
    });

    it('the org fallback does not start without time left; one of the three is reused all the same', async () => {
        const r = await run(
            { models: trio, fallback: fb },
            { a: ok('a'), b: fail('b'), c: ok('c'), f: ok('f') },
            {},
            () => false,
        );
        expect(r.started).not.toContain('f');
        expect(
            r.runs.find((o) => o.modelId === 'b')?.replacedBy,
        ).toBeUndefined();
        expect(r.outputs.map((o) => o.output)).toContainEqual(['b-partial']);

        // Reusing a run of the three costs no time: no gate on it.
        const inTrio = await run(
            { models: trio, fallback: model('fallback', 'c') },
            { a: ok('a'), b: fail('b'), c: ok('c') },
            {},
            () => false,
        );
        expect(inTrio.runs.find((o) => o.modelId === 'b')).toMatchObject({
            replacedBy: 'c',
            reusedRun: true,
        });
    });
});

describe('ultraReviewOutcome', () => {
    const runs = (n: number) =>
        ['a', 'b', 'c'].map((id, i) => ({
            position: (i + 1) as 1 | 2 | 3,
            modelId: id,
            modelName: id,
            status: i < n ? ('completed' as const) : ('failed' as const),
        }));

    it('is a success only with three distinct models and a merge that ran', () => {
        const merged = {
            status: 'success' as const,
            inputCount: 3,
            outputCount: 2,
        };
        expect(ultraReviewOutcome(runs(3), merged)).toBe('success');
        expect(
            ultraReviewOutcome(runs(3), { ...merged, status: 'fallback' }),
        ).toBe('success');
        expect(
            ultraReviewOutcome(runs(3), { ...merged, status: 'failed' }),
        ).toBe('degraded');
        expect(ultraReviewOutcome(runs(2), merged)).toBe('degraded');
        expect(ultraReviewOutcome(runs(0), merged)).toBe('failed');
    });

    it('is degraded when Kody Rules and custom agents did not finish', () => {
        const merged = {
            status: 'success' as const,
            inputCount: 3,
            outputCount: 2,
        };
        expect(ultraReviewOutcome(runs(3), merged, true)).toBe('degraded');
        expect(ultraReviewOutcome(runs(0), merged, true)).toBe('failed');
    });
});
