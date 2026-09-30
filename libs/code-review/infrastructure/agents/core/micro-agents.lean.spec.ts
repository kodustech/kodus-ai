import { buildMicroAgentPrompt, MICRO_AGENTS } from './micro-agents';

// #1821: the lean-output knob is eval-only. Off, the lens prompt must stay the
// production text byte for byte; on, only the per-finding shape changes.
describe('buildMicroAgentPrompt — lean output', () => {
    const group = MICRO_AGENTS[0];

    it('leaves the production prompt unchanged when off', () => {
        for (const g of MICRO_AGENTS) {
            expect(buildMicroAgentPrompt(g, 'DIFF', 'GRAPH', 4, false, false, false, false)).toBe(
                buildMicroAgentPrompt(g, 'DIFF', 'GRAPH', 4),
            );
        }
    });

    it('asks only for label, file, lines and description per finding when on', () => {
        const lean = buildMicroAgentPrompt(group, 'DIFF', undefined, 4, false, false, false, true);
        const shape = lean.slice(lean.indexOf('"suggestions"'), lean.indexOf('```', lean.indexOf('"suggestions"')));
        for (const field of ['"label"', '"relevantFile"', '"relevantLinesStart"', '"relevantLinesEnd"', '"suggestionContent"']) {
            expect(shape).toContain(field);
        }
        for (const field of ['"existingCode"', '"improvedCode"', '"oneSentenceSummary"', '"reason"', '"severity"', '"confidence"', '"language"']) {
            expect(shape).not.toContain(field);
        }
        expect(lean).not.toContain('Assign confidence honestly');
    });

    it('keeps everything outside the per-finding shape', () => {
        const full = buildMicroAgentPrompt(group, 'DIFF', undefined, 4);
        const lean = buildMicroAgentPrompt(group, 'DIFF', undefined, 4, false, false, false, true);
        expect(lean.slice(0, lean.indexOf('<OutputFormat>'))).toBe(full.slice(0, full.indexOf('<OutputFormat>')));
        expect(lean).toContain('AT MOST 4');
        expect(lean).toContain('"reasoning" is REQUIRED');
    });
});
