import { buildMicroAgentPrompt, MICRO_AGENTS } from './micro-agents';

// #1821: the lens output is lean — each finding carries only label, file,
// lines and description; snippet, fix, severity and confidence come later.
describe('buildMicroAgentPrompt — lean output', () => {
    it('asks only for label, file, lines and description per finding', () => {
        for (const g of MICRO_AGENTS) {
            const p = buildMicroAgentPrompt(g, 'DIFF', undefined, 4);
            const shape = p.slice(p.indexOf('"suggestions"'), p.indexOf('```', p.indexOf('"suggestions"')));
            for (const field of ['"label"', '"relevantFile"', '"relevantLinesStart"', '"relevantLinesEnd"', '"suggestionContent"']) {
                expect(shape).toContain(field);
            }
            for (const field of ['"existingCode"', '"improvedCode"', '"oneSentenceSummary"', '"reason"', '"severity"', '"confidence"', '"language"']) {
                expect(shape).not.toContain(field);
            }
            expect(p).not.toMatch(/confidence/i);
            expect(p).toContain('AT MOST 4');
            expect(p).toContain('"reasoning" is REQUIRED');
        }
    });
});
