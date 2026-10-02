import {
    isDefaultWritingGuidelines,
    knownWritingGuidelines,
    matchKnownWritingGuidelines,
    resolveWritingGuidelines,
    samePromptText,
} from './writing-guidelines';

jest.mock('./validateCodeReviewConfigFile', () => ({
    getDefaultKodusConfigFile: () => ({
        v2PromptOverrides: {
            generation: {
                main: 'Current default.\n- **Two sentences at most**.',
            },
        },
    }),
}));

const tiptap = (...paragraphs: string[]) =>
    JSON.stringify({
        type: 'doc',
        content: paragraphs.map((text) => ({
            type: 'paragraph',
            content: [{ type: 'text', text }],
        })),
    });

describe('isDefaultWritingGuidelines', () => {
    it('recognises the current default however it was serialised', () => {
        expect(
            isDefaultWritingGuidelines(
                'Current default.\n- **Two sentences at most**.',
            ),
        ).toBe(true);
        expect(
            isDefaultWritingGuidelines(
                tiptap('Current default.', 'Two sentences at most.'),
            ),
        ).toBe(true);
    });

    it('recognises the 2025 default, the 2026-02 default and the onboarding coach preset', () => {
        expect(
            isDefaultWritingGuidelines(
                'Detailed and verifiable issue description',
            ),
        ).toBe(true);
        expect(
            isDefaultWritingGuidelines(
                tiptap(
                    'Detailed and verifiable issue description',
                    'No conversational filler: Avoid phrases like "I noticed that," "It seems like," or "You should consider."',
                    'Execute "Brevity First": Eliminate all introductory pleasantries. Start descriptions with the noun of the error (e.g., "Memory leak," "Null pointer dereference," "Timing attack").',
                    'Direct addressing: State the problem immediately, followed by the technical cause.',
                    'Strictly technical: Use only domain-specific terminology. If a bug is a race condition, start with "Race condition identified in..."',
                    'Use Active Voice: "The function leaks memory" instead of "Memory is leaked by the function."',
                    'Sentence cap: Limit the description to 1-2 high-impact sentences.',
                ),
            ),
        ).toBe(true);
        expect(
            isDefaultWritingGuidelines(
                'Adopt a coaching tone: - Explain briefly the why behind each issue. - Suggest how to validate (tests/checks). - Prefer concise examples. - Avoid nitpicks and group by priority.',
            ),
        ).toBe(true);
    });

    it('treats an edited text as custom', () => {
        expect(
            isDefaultWritingGuidelines(
                'Detailed and verifiable issue description. Always reply in a friendly tone.',
            ),
        ).toBe(false);
    });
});

describe('resolveWritingGuidelines', () => {
    it('replaces any known default with the current default and marks it not custom', () => {
        expect(
            resolveWritingGuidelines(
                'Detailed and verifiable issue description',
            ),
        ).toEqual({
            text: 'Current default.\n- **Two sentences at most**.',
            isCustom: false,
        });
    });

    it('keeps a real edit as custom text', () => {
        expect(
            resolveWritingGuidelines(tiptap('Write like a senior reviewer.')),
        ).toEqual({
            text: 'Write like a senior reviewer.',
            isCustom: true,
        });
    });

    it('falls back to the current default when nothing is set', () => {
        expect(resolveWritingGuidelines(undefined)).toEqual({
            text: 'Current default.\n- **Two sentences at most**.',
            isCustom: false,
        });
    });
});

describe('matchKnownWritingGuidelines', () => {
    it('names the shipped text a value matches', () => {
        expect(
            matchKnownWritingGuidelines(
                'Detailed and verifiable issue description',
            ),
        ).toBe('default-2025');
        expect(
            matchKnownWritingGuidelines(
                'Current default.\n- **Two sentences at most**.',
            ),
        ).toBe('default-current');
        expect(
            matchKnownWritingGuidelines(
                'Adopt a coaching tone: - Explain briefly the why behind each issue. - Suggest how to validate (tests/checks). - Prefer concise examples. - Avoid nitpicks and group by priority.',
            ),
        ).toBe('preset-coach');
    });

    it('returns null for a real edit or an empty value', () => {
        expect(
            matchKnownWritingGuidelines(
                'Detailed and verifiable issue description. Be friendly.',
            ),
        ).toBeNull();
        expect(matchKnownWritingGuidelines('')).toBeNull();
        expect(matchKnownWritingGuidelines(undefined)).toBeNull();
    });

    it('lists the known texts by name, for tools that report on them', () => {
        expect(knownWritingGuidelines().map((k) => k.name)).toEqual([
            'default-current',
            'default-2025',
            'default-2026-02',
            'preset-coach',
        ]);
    });
});

describe('prompt comparison preserves technical edits', () => {
    it.each([
        ['Flag count > 10.', 'Flag count < 10.'],
        ['Use UserID.', 'Use userId.'],
        ['Use a_b.', 'Use ab.'],
        ['Use a * b.', 'Use a b.'],
        ['Use a**b**c.', 'Use abc.'],
        ['Use a__b__c.', 'Use abc.'],
    ])('distinguishes %s from %s', (parent, edited) => {
        expect(samePromptText(parent, tiptap(edited))).toBe(false);
    });
    it('keeps casing edits to shipped defaults custom', () => {
        expect(
            resolveWritingGuidelines(
                'DETAILED AND VERIFIABLE ISSUE DESCRIPTION',
            ).isCustom,
        ).toBe(true);
    });
});
