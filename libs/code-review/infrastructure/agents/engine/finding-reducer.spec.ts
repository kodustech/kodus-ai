import {
    REDUCER_QUOTA,
    REDUCER_THRESHOLD,
    groupFeatures,
    passesContract,
    reduceFindings,
    reducerProbability,
    type ReducerCandidate,
} from './finding-reducer';

const cand = (over: Partial<ReducerCandidate> = {}): ReducerCandidate => ({
    relevantFile: 'src/a.ts',
    relevantLinesStart: 10,
    relevantLinesEnd: 12,
    oneSentenceSummary: 'something',
    suggestionContent: 'body',
    severity: 'high',
    confidence: 8,
    reason: 'walked from a.ts:10 to b.ts:4',
    producedBy: 'micro-authorization',
    ...over,
});

/** Atribuidor devolve um grupo por candidato, com as notas dadas. */
const attributorOf = (notas: number[]) => ({
    grupos: notas.map((nota, i) => ({
        indices: [i],
        representante: i,
        nota,
        porque: 'x',
    })),
});

function callerFor(
    attributor: unknown,
    veracity: unknown = { itens: [] },
): { call: any; prompts: string[] } {
    const prompts: string[] = [];
    const call = jest.fn(async ({ prompt, runName }) => {
        prompts.push(prompt);
        if (String(runName).includes('attributor')) {
            if (attributor instanceof Error) throw attributor;
            return attributor;
        }
        if (veracity instanceof Error) throw veracity;
        return veracity;
    });
    return { call, prompts };
}

describe('passesContract', () => {
    it('keeps a finding on the declared severity scale that carries its walk', () => {
        expect(passesContract(cand())).toBe(true);
    });

    it('drops a severity outside the declared scale', () => {
        expect(passesContract(cand({ severity: 'info' }))).toBe(false);
        expect(passesContract(cand({ severity: 'error' }))).toBe(false);
        expect(passesContract(cand({ severity: undefined }))).toBe(false);
    });

    it('drops a finding with no walk', () => {
        expect(passesContract(cand({ reason: undefined }))).toBe(false);
    });
});

describe('groupFeatures', () => {
    it('treats a missing veracity score as "cannot tell", not as zero', () => {
        expect(groupFeatures([cand()], 80, undefined).ver).toBe(0.5);
        expect(groupFeatures([cand()], 80, 0).ver).toBe(0);
    });

    it('caps group size at four members and distinct agents at three', () => {
        const many = Array.from({ length: 9 }, (_, i) =>
            cand({ producedBy: `micro-${i}` }),
        );
        const f = groupFeatures(many, 50, 50);
        expect(f.tam).toBe(1);
        expect(f.nag).toBe(1);
    });

    it('takes the strongest severity in the group', () => {
        const f = groupFeatures(
            [cand({ severity: 'low' }), cand({ severity: 'critical' })],
            50,
            50,
        );
        expect(f.sev).toBe(1);
    });
});

describe('reducerProbability', () => {
    it('ranks a true AND important finding above one that is only one of the two', () => {
        const both = reducerProbability(groupFeatures([cand()], 90, 90));
        const importantOnly = reducerProbability(groupFeatures([cand()], 90, 20));
        const trueOnly = reducerProbability(groupFeatures([cand()], 20, 90));
        expect(both).toBeGreaterThan(importantOnly);
        expect(both).toBeGreaterThan(trueOnly);
    });

    it('is the published operating point: the default rule posts at most the quota', () => {
        expect(REDUCER_QUOTA).toBe(7);
        expect(REDUCER_THRESHOLD).toBeCloseTo(0.22);
    });
});

describe('reduceFindings', () => {
    it('drops off-contract candidates before the attributor ever sees them', async () => {
        const { call, prompts } = callerFor(attributorOf([90, 90]));
        const out = await reduceFindings({
            candidates: [
                cand({ oneSentenceSummary: 'real one' }),
                cand({ severity: 'info', oneSentenceSummary: 'annotation' }),
                cand({ reason: undefined, oneSentenceSummary: 'no walk' }),
                cand({ oneSentenceSummary: 'real two' }),
            ],
            diff: 'diff',
            call,
        });
        expect(out.trace.contractDroppedCount).toBe(2);
        expect(prompts[0]).toContain('real one');
        expect(prompts[0]).toContain('real two');
        expect(prompts[0]).not.toContain('annotation');
        expect(prompts[0]).not.toContain('no walk');
    });

    it('falls back to the severity check when no candidate carries a walk', async () => {
        const { call } = callerFor(attributorOf([90, 90]));
        const out = await reduceFindings({
            candidates: [
                cand({ reason: undefined }),
                cand({ reason: undefined, severity: 'info' }),
            ],
            diff: 'diff',
            call,
        });
        // sem o fallback isto seria uma revisao vazia
        expect(out.trace.contractDroppedCount).toBe(1);
        expect(out.suggestions.length).toBe(1);
    });

    it('posts at most the quota, best first', async () => {
        const notas = [10, 20, 30, 40, 50, 60, 70, 80, 90];
        const { call } = callerFor(
            attributorOf(notas),
            { itens: notas.map((n, i) => ({ indice: i, verdadeiro: n, ancora: 'a:1' })) },
        );
        const out = await reduceFindings({
            candidates: notas.map((n) =>
                cand({ oneSentenceSummary: `finding ${n}` }),
            ),
            diff: 'diff',
            call,
            quota: 3,
            threshold: 0,
        });
        expect(out.suggestions).toHaveLength(3);
        expect(out.suggestions.map((s) => s.oneSentenceSummary)).toEqual([
            'finding 90',
            'finding 80',
            'finding 70',
        ]);
    });

    it('posts fewer than the quota when a PR has nothing above the threshold', async () => {
        const { call } = callerFor(
            attributorOf([0, 0, 0]),
            { itens: [0, 1, 2].map((i) => ({ indice: i, verdadeiro: 0, ancora: 'a:1' })) },
        );
        const out = await reduceFindings({
            candidates: [cand(), cand(), cand()],
            diff: 'diff',
            call,
            quota: 7,
        });
        expect(out.suggestions).toHaveLength(0);
        expect(out.trace.groupsCount).toBe(3);
    });

    it('folds the other occurrences of one defect into the representative', async () => {
        const { call } = callerFor(
            { grupos: [{ indices: [0, 1], representante: 0, nota: 90, porque: 'x' }] },
            { itens: [{ indice: 0, verdadeiro: 90, ancora: 'a:1' }] },
        );
        const out = await reduceFindings({
            candidates: [
                cand({ relevantFile: 'a.ts', suggestionContent: 'the defect' }),
                cand({ relevantFile: 'b.ts', relevantLinesStart: 50, relevantLinesEnd: 51 }),
            ],
            diff: 'diff',
            call,
            threshold: 0,
        });
        expect(out.suggestions).toHaveLength(1);
        expect(out.suggestions[0].suggestionContent).toContain('the defect');
        expect(out.suggestions[0].suggestionContent).toContain('b.ts:50-51');
    });

    it('keeps everything when the attributor fails — never turns a review into silence', async () => {
        const { call } = callerFor(new Error('503'));
        const candidates = [cand(), cand(), cand()];
        const out = await reduceFindings({ candidates, diff: 'diff', call });
        expect(out.suggestions).toHaveLength(3);
        expect(out.trace.status).toBe('failed-keep-all');
    });

    it('still ranks on the attributor score when veracity fails', async () => {
        const { call } = callerFor(attributorOf([10, 95]), new Error('timeout'));
        const out = await reduceFindings({
            candidates: [
                cand({ oneSentenceSummary: 'weak' }),
                cand({ oneSentenceSummary: 'strong' }),
            ],
            diff: 'diff',
            call,
            quota: 1,
            threshold: 0,
        });
        expect(out.suggestions.map((s) => s.oneSentenceSummary)).toEqual(['strong']);
    });

    it('never loses a candidate the attributor forgot to mention', async () => {
        const { call } = callerFor(
            { grupos: [{ indices: [0], representante: 0, nota: 90, porque: 'x' }] },
            { itens: [] },
        );
        const out = await reduceFindings({
            candidates: [cand(), cand({ oneSentenceSummary: 'forgotten' })],
            diff: 'diff',
            call,
            quota: 7,
            threshold: 0,
        });
        expect(out.trace.groupsCount).toBe(2);
        expect(out.suggestions.map((s) => s.oneSentenceSummary)).toContain(
            'forgotten',
        );
    });

    it('skips both LLM calls for a single candidate', async () => {
        const { call } = callerFor(attributorOf([90]));
        const out = await reduceFindings({
            candidates: [cand()],
            diff: 'diff',
            call,
        });
        expect(call).not.toHaveBeenCalled();
        expect(out.suggestions).toHaveLength(1);
        expect(out.trace.status).toBe('skipped');
    });
});
