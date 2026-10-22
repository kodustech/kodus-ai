import { formatAndShapeSuggestions } from './format-and-shape-suggestions';
import { formatSuggestionContent } from '@libs/code-review/infrastructure/agents/engine/format-suggestion-content';
import { ANALYZER_SOURCE } from '@libs/code-review/infrastructure/analyzers/analyzer-findings-to-suggestions';

jest.mock(
    '@libs/code-review/infrastructure/agents/engine/format-suggestion-content',
    () => ({ formatSuggestionContent: jest.fn() }),
);
const formatter = formatSuggestionContent as jest.MockedFunction<
    typeof formatSuggestionContent
>;

const DEFAULT = { text: 'default guidelines', isCustom: false };
const SCAFFOLDED =
    'WHAT: The loop reads past the end. WHY: The last read throws on an empty list. HOW: Stop at length minus one.';

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
        formatter.mockResolvedValue(
            new Map([
                [
                    0,
                    {
                        suggestionContent: 'One. Two. Three.\n```ts\nx\n```',
                    } as any,
                ],
            ]),
        );
        const s = [finding()];
        const r = await formatAndShapeSuggestions(s, {
            writingGuidelines: DEFAULT,
            languageResultPrompt: 'pt-BR',
            organizationId: 'org',
        });
        expect(s[0].suggestionContent).toBe('One. Two.');
        expect(r).toMatchObject({
            formatted: 1,
            formatTargets: 1,
            shapeCounts: {
                shaped: 1,
                removedFences: 1,
                capped: 1,
                impactActionFallback: 0,
            },
        });
        expect(formatter.mock.calls[0][0][0]).toMatchObject({
            title: 'Loop reads past the end of the list',
            suggestionContent: SCAFFOLDED,
        });
        expect(formatter.mock.calls[0][1]).toMatchObject({
            customWritingGuidelines: undefined,
            languageResultPrompt: 'pt-BR',
            organizationId: 'org',
        });
    });

    it('falls back to the impact and the action when the formatter returned nothing', async () => {
        formatter.mockResolvedValue(new Map());
        const s = [finding()];
        const r = await formatAndShapeSuggestions(s, {
            writingGuidelines: DEFAULT,
            organizationId: 'org',
        });
        expect(s[0].suggestionContent).toBe(
            'The last read throws on an empty list. Stop at length minus one.',
        );
        expect(r.shapeCounts.impactActionFallback).toBe(1);
    });

    it("hands a team's own guidelines to the formatter and neither falls back nor caps", async () => {
        formatter.mockResolvedValue(
            new Map([[0, { suggestionContent: 'One. Two. Three.' } as any]]),
        );
        const s = [finding()];
        const r = await formatAndShapeSuggestions(s, {
            writingGuidelines: { text: 'Write one sentence.', isCustom: true },
            organizationId: 'org',
        });
        expect(formatter.mock.calls[0][1]).toMatchObject({
            customWritingGuidelines: 'Write one sentence.',
        });
        expect(s[0].suggestionContent).toBe('One. Two. Three.');
        expect(r.shapeCounts).toMatchObject({
            capped: 0,
            impactActionFallback: 0,
        });
    });

    it("leaves an analyzer's finding out of both passes", async () => {
        formatter.mockResolvedValue(new Map());
        const analyzer = finding({
            suggestionContent: '- pkg a\n- pkg b',
            evidence: { source: ANALYZER_SOURCE },
        });
        const s = [analyzer, finding()];
        const r = await formatAndShapeSuggestions(s as any, {
            writingGuidelines: DEFAULT,
            organizationId: 'org',
        });
        expect(formatter.mock.calls[0][0]).toHaveLength(1);
        expect(s[0].suggestionContent).toBe('- pkg a\n- pkg b');
        expect(r).toMatchObject({
            formatTargets: 1,
            shapeCounts: { shaped: 1 },
        });
    });

    it('keeps each text and still shapes it when the formatter throws', async () => {
        formatter.mockRejectedValue(new Error('provider down'));
        const s = [
            finding({ suggestionContent: 'Plain prose. Second. Third.' }),
        ];
        const r = await formatAndShapeSuggestions(s, {
            writingGuidelines: DEFAULT,
            organizationId: 'org',
        });
        expect(r.formatted).toBeNull();
        expect(String((r.formatError as Error).message)).toBe('provider down');
        expect(s[0].suggestionContent).toBe('Plain prose. Second.');
    });

    describe('title over the ceiling (#2157)', () => {
        const LONG =
            '`Array.prototype.forEach` does not await its async callback, so `bulkReassign` returns `{ reassigned: 0, skipped: 0 }` before any await resolves';

        it("ships the formatter's title instead of cutting it", async () => {
            formatter.mockResolvedValue(new Map([[0, { suggestionContent: 'Counts are always zero. Use for...of.', title: '`forEach` does not await its async callback' } as any]]));
            const s = [finding({ oneSentenceSummary: LONG })];
            const r = await formatAndShapeSuggestions(s, { writingGuidelines: DEFAULT, organizationId: 'org' });
            expect(formatter.mock.calls[0][0][0]).toMatchObject({ title: LONG, rewriteTitle: true });
            expect(s[0].oneSentenceSummary).toBe('`forEach` does not await its async callback');
            expect(r.shapeCounts).toMatchObject({ titleRewritten: 1, titleCut: 0 });
        });

        it('cuts it as before when the formatter returned no title or failed', async () => {
            for (const answer of [new Map([[0, { suggestionContent: 'Body.' } as any]]), new Map([[0, { suggestionContent: 'Body.', title: '   ' } as any]])]) {
                formatter.mockResolvedValue(answer);
                const s = [finding({ oneSentenceSummary: LONG })];
                const r = await formatAndShapeSuggestions(s, { writingGuidelines: DEFAULT, organizationId: 'org' });
                expect(s[0].oneSentenceSummary).toBe('`Array.prototype.forEach` does not await its async callback, so `bulkReassign` returns…');
                expect(r.shapeCounts).toMatchObject({ titleRewritten: 0, titleCut: 1 });
            }
            formatter.mockRejectedValue(new Error('down'));
            const s = [finding({ oneSentenceSummary: LONG })];
            await formatAndShapeSuggestions(s, { writingGuidelines: DEFAULT, organizationId: 'org' });
            expect(s[0].oneSentenceSummary.endsWith('returns…')).toBe(true);
        });

        it('still bounds a rewritten title that is too long', async () => {
            formatter.mockResolvedValue(new Map([[0, { suggestionContent: 'Body.', title: `${LONG} and more` } as any]]));
            const s = [finding({ oneSentenceSummary: LONG })];
            await formatAndShapeSuggestions(s, { writingGuidelines: DEFAULT, organizationId: 'org' });
            expect(s[0].oneSentenceSummary.length).toBeLessThanOrEqual(100);
            expect(s[0].oneSentenceSummary.endsWith('…')).toBe(true);
        });

        it('drops quotes the model put around its title', async () => {
            formatter.mockResolvedValue(new Map([[0, { suggestionContent: 'Body.', title: '"`forEach` does not await its callback"' } as any]]));
            const s = [finding({ oneSentenceSummary: LONG })];
            await formatAndShapeSuggestions(s, { writingGuidelines: DEFAULT, organizationId: 'org' });
            expect(s[0].oneSentenceSummary).toBe('`forEach` does not await its callback');
        });

        it('ignores a title the formatter was not asked for', async () => {
            formatter.mockResolvedValue(new Map([[0, { suggestionContent: 'Body.', title: 'Something else' } as any]]));
            const s = [finding()];
            const r = await formatAndShapeSuggestions(s, { writingGuidelines: DEFAULT, organizationId: 'org' });
            expect(formatter.mock.calls[0][0][0]).toMatchObject({ rewriteTitle: false });
            expect(s[0].oneSentenceSummary).toBe('Loop reads past the end of the list');
            expect(r.shapeCounts).toMatchObject({ titleRewritten: 0, titleCut: 0 });
        });

        it("bounds an analyzer's title, which skips the formatter", async () => {
            formatter.mockResolvedValue(new Map());
            const s = [finding({ oneSentenceSummary: LONG, suggestionContent: '- pkg a', evidence: { source: ANALYZER_SOURCE } })];
            await formatAndShapeSuggestions(s as any, { writingGuidelines: DEFAULT, organizationId: 'org' });
            expect(s[0].oneSentenceSummary.length).toBeLessThanOrEqual(100);
        });

        it('drops a body opening that repeats the new title', async () => {
            formatter.mockResolvedValue(new Map([[0, { suggestionContent: 'forEach does not await its async callback. Counts are always zero.', title: '`forEach` does not await its async callback' } as any]]));
            const s = [finding({ oneSentenceSummary: LONG })];
            await formatAndShapeSuggestions(s, { writingGuidelines: DEFAULT, organizationId: 'org' });
            expect(s[0].suggestionContent).toBe('Counts are always zero.');
        });
    });
});

describe('formatAndShapeSuggestions — a custom agent voice', () => {
    beforeEach(() => formatter.mockReset());

    const agents = (writing: string) =>
        new Map([
            [
                'ag',
                { id: 'ag', name: 'Money', presentation: { writing } } as any,
            ],
        ]);

    it("writes in the team's language even when the voice names another", async () => {
        formatter.mockResolvedValue(
            new Map([[0, { suggestionContent: 'Um. Dois.' } as any]]),
        );
        const s = [finding({ customAgent: { id: 'ag', name: 'Money' } })];
        const title = s[0].oneSentenceSummary;
        await formatAndShapeSuggestions(s, {
            writingGuidelines: DEFAULT,
            languageResultPrompt: 'pt-BR',
            organizationId: 'org',
            customAgentsById: agents('Escribe en español. Sé breve.'),
        });
        expect(formatter.mock.calls[0][1]).toMatchObject({
            customWritingGuidelines: 'Escribe en español. Sé breve.',
            languageResultPrompt: 'pt-BR',
        });
        expect(s[0].oneSentenceSummary).toBe(title);
    });
});
