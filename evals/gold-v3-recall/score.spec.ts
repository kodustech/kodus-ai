// eslint-disable-next-line @typescript-eslint/no-require-imports
const { linesOf, scoreLine, pool, validIssues } = require('./score');

const item = (file: string, text: string) => ({ relevantFile: file, relevantLinesStart: 1, relevantLinesEnd: 2, label: 'bug', suggestionContent: text });
const dump = (stages: string) => ({
    manifest: { stages },
    finderPasses: [
        {
            agentName: 'kodus-generalist-review-agent',
            verify: [{ pass: 'verify', items: [item('a.ts', 'real bug'), item('b.ts', 'noise')] }],
            candidates: [
                { index: 0, origin: 'generalist', verify: 'kept' },
                { index: 1, origin: 'synthesis-rescue', verify: 'dropped' },
            ],
        },
    ],
    findings: [item('a.ts', 'real bug, enriched')],
});

describe('evals/gold-v3-recall/score.js', () => {
    it('reads only the lines a run reached', () => {
        expect(Object.keys(linesOf(dump('finder')).lines)).toEqual(['finder']);
        expect(Object.keys(linesOf(dump('verify')).lines)).toEqual(['finder', 'verify']);
        expect(Object.keys(linesOf(dump('full')).lines)).toEqual(['finder', 'verify', 'shipped']);
    });

    it('keeps the verify verdict and the pass of each finder candidate', () => {
        const { lines } = linesOf(dump('full'));
        expect(lines.finder.map((c: { origin: string }) => c.origin)).toEqual(['generalist', 'synthesis-rescue']);
        expect(lines.verify.map((c: { text: string }) => c.text)).toEqual(['real bug']);
    });

    it('refuses a dump written before the candidates were recorded', () => {
        const old = dump('full');
        delete (old.finderPasses[0].verify[0] as { items?: unknown }).items;
        expect(() => linesOf(old)).toThrow(/re-run/);
    });

    it('counts each valid TP once; a repeat, a nit or a pending TP is a FP', () => {
        const upstream = { 'x#1': 'confirmado', 'x#2': 'confirmado', 'x#3': 'pendente' };
        const gold = [
            { issueId: 'x#1', class: 'TP', subclass: null },
            { issueId: 'x#2', class: 'TP', subclass: 'nit' },
            { issueId: 'x#3', class: 'TP', subclass: null },
        ];
        const valid = validIssues(gold, upstream);
        expect([...valid]).toEqual(['x#1']);
        const comments = [{ id: 'C1', origin: 'generalist' }, { id: 'C2', origin: 'synthesis-rescue' }, { id: 'C3', origin: 'generalist' }, { id: 'C4' }, { id: 'C5' }];
        const answers = new Map([
            ['C1', { match: 'x#1' }],
            ['C2', { match: 'new' }],
            ['C3', { match: 'x#1' }],
            ['C4', { match: 'x#2' }],
            ['C5', { match: 'x#3' }],
        ]);
        const s = scoreLine(comments, answers, valid);
        expect([s.tp, s.fp, s.found, s.valid]).toEqual([1, 4, ['x#1'], 1]);
        const p = pool([{ lines: { finder: s } }], 'finder');
        expect([p.recall, p.precision]).toEqual([1, 0.2]);
        expect(p.byOrigin.generalist).toEqual({ comments: 2, issues: 1 });
    });
});
