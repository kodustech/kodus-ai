import {
    buildEnrichmentInput,
    enrichSuggestions,
    numberedWindow,
} from './enrich-suggestions';

const content = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const file = {
    filename: 'src/orders.ts',
    fileContent: content,
    patch: '@@ -100,1 +100,2 @@\n+line 101',
};
const finding = (over: Record<string, unknown> = {}) => ({
    label: 'bug',
    relevantFile: 'src/orders.ts',
    relevantLinesStart: 100,
    relevantLinesEnd: 101,
    suggestionContent: 'The total ignores the quantity.',
    ...over,
});

describe('numberedWindow', () => {
    it('numbers 60 lines on each side, cut at the file edges', () => {
        const w = numberedWindow(content, 100, 101).split('\n');
        expect(w[0]).toBe('   40 | line 40');
        expect(w[w.length - 1]).toBe('  161 | line 161');
        expect(numberedWindow(content, 2, 2).split('\n')[0]).toBe('    1 | line 1');
        expect(numberedWindow(content, 199, 200).split('\n').slice(-2)).toEqual(['  200 | line 200', '  201 | ']);
    });
});

describe('buildEnrichmentInput', () => {
    it('gives the call the cited code, the fence language, the window and the diff', () => {
        const input = buildEnrichmentInput(finding(), file);
        expect(input.existingCode).toBe('line 100\nline 101');
        expect(input.language).toBe('typescript');
        expect(input.fileWindow).toContain('  100 | line 100');
        expect(input.filePatch).toBe(file.patch);
        expect(input.finding).toEqual({
            label: 'bug',
            relevantFile: 'src/orders.ts',
            relevantLinesStart: 100,
            relevantLinesEnd: 101,
            suggestionContent: 'The total ignores the quantity.',
        });
    });

    it('sends no code and no window when the file is not at the head', () => {
        const input = buildEnrichmentInput(finding(), undefined);
        expect(input.existingCode).toBe('');
        expect(input.fileWindow).toBe('');
    });
});

describe('enrichSuggestions', () => {
    const run = (suggestions: any[], enrich: jest.Mock, shouldEnrich = (s: any) => s.label !== 'kody_rules') =>
        enrichSuggestions(suggestions, [file], { shouldEnrich, enrich: enrich as any });

    it('writes the title, the cited code and a local fix', async () => {
        const enrich = jest.fn().mockResolvedValue({
            oneSentenceSummary: 'Total ignores item quantity',
            fixStatus: 'local',
            improvedCode: 'line 100 * qty\nline 101',
        });
        const { suggestions, counts } = await run([finding()], enrich);
        expect(suggestions[0]).toMatchObject({
            oneSentenceSummary: 'Total ignores item quantity',
            existingCode: 'line 100\nline 101',
            language: 'typescript',
            improvedCode: 'line 100 * qty\nline 101',
            suggestionContent: 'The total ignores the quantity.',
        });
        expect(counts).toEqual({ enriched: 1, failed: 0, skipped: 0, byFixStatus: { local: 1 } });
    });

    it('posts no code when the fix does not fit the cited lines', async () => {
        const enrich = jest.fn().mockResolvedValue({
            oneSentenceSummary: 'Lock is never released',
            fixStatus: 'needs-wider-change',
            improvedCode: '',
        });
        const { suggestions } = await run([finding()], enrich);
        expect(suggestions[0].improvedCode).toBeUndefined();
        expect(suggestions[0].oneSentenceSummary).toBe('Lock is never released');
    });

    it('keeps a suggestion whose call failed, with its cited code', async () => {
        const enrich = jest.fn().mockRejectedValueOnce(new Error('429')).mockResolvedValueOnce(null);
        const { suggestions, counts } = await run([finding(), finding({ relevantLinesStart: 5, relevantLinesEnd: 5 })], enrich);
        expect(suggestions).toHaveLength(2);
        expect(suggestions[0].existingCode).toBe('line 100\nline 101');
        expect(suggestions[0].oneSentenceSummary).toBeUndefined();
        expect(counts.failed).toBe(2);
    });

    it('leaves the suggestions it does not take, in their order', async () => {
        const enrich = jest.fn().mockResolvedValue({ oneSentenceSummary: 'T', fixStatus: 'no-code-fix', improvedCode: '' });
        const rule = { label: 'kody_rules', existingCode: 'x', improvedCode: 'y' };
        const { suggestions, counts } = await run([rule, finding()], enrich);
        expect(suggestions[0]).toBe(rule);
        expect(suggestions[1].oneSentenceSummary).toBe('T');
        expect(enrich).toHaveBeenCalledTimes(1);
        expect(counts.skipped).toBe(1);
    });

    it('runs at most the concurrency limit at once', async () => {
        let inFlight = 0;
        let peak = 0;
        const enrich = jest.fn(async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            inFlight--;
            return { oneSentenceSummary: 'T', fixStatus: 'local', improvedCode: 'x' };
        });
        await enrichSuggestions(Array.from({ length: 12 }, () => finding()), [file], {
            shouldEnrich: () => true,
            enrich: enrich as any,
            concurrency: 3,
        });
        expect(enrich).toHaveBeenCalledTimes(12);
        expect(peak).toBe(3);
    });
});
