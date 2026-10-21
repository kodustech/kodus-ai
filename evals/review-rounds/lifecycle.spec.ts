// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sequences } = require('./lifecycle');

describe('Kody Rules lifecycle acceptance fixtures', () => {
    const rules = () => sequences().filter((s) => s.id.startsWith('rules-'));

    it('requires a real initial finding before scoring suppression', () => {
        for (const sequence of rules()) {
            expect(sequence.rounds).toHaveLength(6);
            expect(sequence.rounds[0].previousDecisions).toBeUndefined();
            expect(sequence.rounds[0].claims[0].expect).toBe('deliver');
            expect(sequence.rounds.every((c) => c.agent === 'kody-rules')).toBe(
                true,
            );
            for (const round of sequence.rounds.slice(1)) {
                expect(round.claims[0].expect).toBe('not_deliver');
                expect(round.changedFiles[0].patch).toContain('@@');
            }
            expect(sequence.rounds.at(-1).claims[1].expect).toBe('deliver');
            expect(sequence.rounds.at(-1).claims[1].id).toBe(
                'finishBatch-new-site',
            );
        }
    });

    it('keeps the declined violation across four nearby commits and line shifts', () => {
        const sequence = rules().find(
            (s) => s.id === 'rules-rejected-four-rounds',
        );
        expect(sequence.historyOutcome).toBe('not_implemented');
        for (const round of sequence.rounds.slice(1, 5)) {
            const content = round.repo['src/jobs/handler.ts'];
            expect(content.indexOf('db.results.insert(run.id')).toBeLessThan(
                content.indexOf('db.progress.update(run.id'),
            );
            expect(round.changedFiles[0].patch).toContain(
                'document completion telemetry',
            );
        }
    });

    it('repairs the violation before three follow-ups despite a pending status', () => {
        const sequence = rules().find(
            (s) => s.id === 'rules-fixed-three-rounds',
        );
        expect(sequence.historyOutcome).toBe('pending');
        for (const round of sequence.rounds.slice(1)) {
            const content = round.repo['src/jobs/handler.ts'];
            expect(content.indexOf('db.progress.update(run.id')).toBeLessThan(
                content.indexOf('db.results.insert(run.id'),
            );
        }
        expect(sequence.rounds[1].changedFiles[0].patch).toContain(
            '+    await db.results.insert(run.id, run.output);',
        );
    });
});
