import { formatAndShapeSuggestions } from './format-and-shape-suggestions';
import { formatSuggestionContent } from '@libs/code-review/infrastructure/agents/engine/format-suggestion-content';
import { ANALYZER_SOURCE } from '@libs/code-review/infrastructure/analyzers/analyzer-findings-to-suggestions';

jest.mock(
    '@libs/code-review/infrastructure/agents/engine/format-suggestion-content',
    () => ({ formatSuggestionContent: jest.fn() }),
);
const formatter = formatSuggestionContent as jest.MockedFunction<typeof formatSuggestionContent>;

const DEFAULT = { text: 'default guidelines', isCustom: false };
const SCAFFOLDED = 'WHAT: The loop reads past the end. WHY: The last read throws on an empty list. HOW: Stop at length minus one.';

const finding = (over: Record<string, unknown> = {}) => ({
    oneSentenceSummary: 'Loop reads past the end of the list',
    suggestionContent: SCAFFOLDED,
    existingCode: 'for (let i = 0; i <= xs.length; i++)',
    improvedCode: 'for (let i = 0; i < xs.length; i++)',
    relevantFile: 'src/list.ts',
    language: 'typescript',
    ...over,
});

describe('formatAndShapeSuggestions', () => {
    beforeEach(() => formatter.mockReset());

    it("ships the formatter's text, shaped: no code block, two sentences", async () => {
        formatter.mockResolvedValue(new Map([[0, { suggestionContent: 'One. Two. Three.\n```ts\nx\n```' } as any]]));
        const s = [finding()];
        const r = await formatAndShapeSuggestions(s, { writingGuidelines: DEFAULT, languageResultPrompt: 'pt-BR', organizationId: 'org' });
        expect(s[0].suggestionContent).toBe('One. Two.');
        expect(r).toMatchObject({ formatted: 1, formatTargets: 1, shapeCounts: { shaped: 1, removedFences: 1, capped: 1, impactActionFallback: 0 } });
        expect(formatter.mock.calls[0][0][0]).toMatchObject({ title: 'Loop reads past the end of the list', suggestionContent: SCAFFOLDED });
        expect(formatter.mock.calls[0][1]).toMatchObject({ customWritingGuidelines: undefined, languageResultPrompt: 'pt-BR', organizationId: 'org' });
    });

    it('falls back to the impact and the action when the formatter returned nothing', async () => {
        formatter.mockResolvedValue(new Map());
        const s = [finding()];
        const r = await formatAndShapeSuggestions(s, { writingGuidelines: DEFAULT });
        expect(s[0].suggestionContent).toBe('The last read throws on an empty list. Stop at length minus one.');
        expect(r.shapeCounts.impactActionFallback).toBe(1);
    });

    it("hands a team's own guidelines to the formatter and neither falls back nor caps", async () => {
        formatter.mockResolvedValue(new Map([[0, { suggestionContent: 'One. Two. Three.' } as any]]));
        const s = [finding()];
        const r = await formatAndShapeSuggestions(s, { writingGuidelines: { text: 'Write one sentence.', isCustom: true } });
        expect(formatter.mock.calls[0][1]).toMatchObject({ customWritingGuidelines: 'Write one sentence.' });
        expect(s[0].suggestionContent).toBe('One. Two. Three.');
        expect(r.shapeCounts).toMatchObject({ capped: 0, impactActionFallback: 0 });
    });

    it("leaves an analyzer's finding out of both passes", async () => {
        formatter.mockResolvedValue(new Map());
        const analyzer = finding({ suggestionContent: '- pkg a\n- pkg b', evidence: { source: ANALYZER_SOURCE } });
        const s = [analyzer, finding()];
        const r = await formatAndShapeSuggestions(s as any, { writingGuidelines: DEFAULT });
        expect(formatter.mock.calls[0][0]).toHaveLength(1);
        expect(s[0].suggestionContent).toBe('- pkg a\n- pkg b');
        expect(r).toMatchObject({ formatTargets: 1, shapeCounts: { shaped: 1 } });
    });

    it('keeps each text and still shapes it when the formatter throws', async () => {
        formatter.mockRejectedValue(new Error('provider down'));
        const s = [finding({ suggestionContent: 'Plain prose. Second. Third.' })];
        const r = await formatAndShapeSuggestions(s, { writingGuidelines: DEFAULT });
        expect(r.formatted).toBeNull();
        expect(String((r.formatError as Error).message)).toBe('provider down');
        expect(s[0].suggestionContent).toBe('Plain prose. Second.');
    });
});
