import { V2_DEFAULT_SEVERITY_FLAGS_TEXT } from '@libs/common/utils/codeReview/v2Defaults';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';
import {
    DEFAULT_SEVERITY_FLAGS,
    buildSeverityPrompt,
    hasCustomSeverityFlags,
    parseSeverityResponse,
} from './severity-prompt';

const suggestion = {
    relevantFile: 'src/app.ts',
    relevantLinesStart: 10,
    relevantLinesEnd: 12,
    suggestionContent: '  The handler throws for users without a profile.  ',
};

describe('buildSeverityPrompt', () => {
    it('rates with the defined levels when the team kept the default criteria', () => {
        const fromConfig = getDefaultKodusConfigFile().v2PromptOverrides.severity.flags;
        for (const flags of [undefined, DEFAULT_SEVERITY_FLAGS, V2_DEFAULT_SEVERITY_FLAGS_TEXT, fromConfig]) {
            const prompt = buildSeverityPrompt([suggestion], flags);
            expect(prompt).toContain('**High:** A supported operational path becomes unusable');
            expect(prompt).toContain('How often the trigger occurs never lowers the level');
            expect(prompt).toContain('[0] File: src/app.ts, lines 10-12\nIssue: The handler throws for users without a profile.');
            expect(prompt).not.toContain('Classify the severity of each code review suggestion based on these criteria');
        }
    });

    it("keeps the team's own criteria when it wrote any", () => {
        const prompt = buildSeverityPrompt([suggestion], { ...DEFAULT_SEVERITY_FLAGS, high: 'Anything touching billing' });
        expect(prompt).toContain('**HIGH**: Anything touching billing');
        expect(prompt).not.toContain('**High:** A supported operational path');
    });

    it('sends a Summary line only for a suggestion that has a title', () => {
        const custom = { ...DEFAULT_SEVERITY_FLAGS, high: 'Anything touching billing' };
        expect(buildSeverityPrompt([suggestion], custom)).not.toContain('Summary:');
        expect(
            buildSeverityPrompt([{ ...suggestion, oneSentenceSummary: 'Profile-less users crash' }], custom),
        ).toContain('Summary: Profile-less users crash');
    });

    it('builds from a suggestion with no fields', () => {
        expect(buildSeverityPrompt([{}] as any)).toContain('[0] File: \nIssue: ');
    });
});

describe('hasCustomSeverityFlags', () => {
    it('ignores blanks and the defaults, whatever their spacing', () => {
        expect(hasCustomSeverityFlags(undefined)).toBe(false);
        expect(hasCustomSeverityFlags({ low: '   ' })).toBe(false);
        expect(hasCustomSeverityFlags({ critical: `  ${V2_DEFAULT_SEVERITY_FLAGS_TEXT.critical.replace(/\n/g, '\n\n')}` })).toBe(false);
        expect(hasCustomSeverityFlags({ medium: 'Our own rule' })).toBe(true);
    });
});

describe('parseSeverityResponse', () => {
    it('reads the answer after reasoning a host returned as content (#2409)', () => {
        // Together cut the reasoning channel at a quoted `</think>`: the rest of
        // the reasoning, quoting code and the format example, came before the
        // answer.
        const reply = [
            '. If reasoning quotes , block ends early, rest read as the answer.',
            "existingCode: `const end = text.indexOf('');` and improvedCode `{ index }`.",
            'Format: {"classifications": [{"index": 0, "severity": "high", "reason": "brief reason"}]}',
            'Index 0 high, index 1 medium, index 2 low.',
            '{"classifications": [{"index": 0, "severity": "high", "reason": "loses every finding"}, {"index": 1, "severity": "medium", "reason": "falls back"}, {"index": 2, "severity": "Low", "reason": "cosmetic"}]}',
        ].join('\n');

        const { classifications, parseOk } = parseSeverityResponse(reply);

        expect(parseOk).toBe(true);
        expect([...classifications]).toEqual([
            [0, 'high'],
            [1, 'medium'],
            [2, 'low'],
        ]);
    });

    it('does not take the prompt example for the answer', () => {
        const example =
            '{"classifications": [{"index": 0, "severity": "high", "reason": "brief reason"}]}';
        // Copied as the answer by a model cut mid-thought.
        expect(parseSeverityResponse(example).parseOk).toBe(false);
        // Quoted in the reasoning, with the real answer cut off after it.
        const truncated = `Format: ${example}\nIndex 0 high.\n{"classifications": [{"index": 0, "severity": "low", "rea`;
        expect(parseSeverityResponse(truncated).parseOk).toBe(false);
    });

    it('keeps the answer when the reply restates the example after it', () => {
        const reply = `{"classifications": [{"index": 0, "severity": "low", "reason": "cosmetic"}]}\nFormat was: {"classifications": [{"index": 0, "severity": "high", "reason": "brief reason"}]}`;

        const { classifications, parseOk } = parseSeverityResponse(reply);

        expect(parseOk).toBe(true);
        expect([...classifications]).toEqual([[0, 'low']]);
    });

    it('recognises the example whatever the order of its fields', () => {
        const reordered =
            '{"classifications":[{"reason":"brief reason","severity":"high","index":0}]}';
        const truncated = `Reasoning quotes { index }. Format: ${reordered}\nNow answer: {"classifications":[{"index":0,"severity":"low","reason":"`;
        expect(parseSeverityResponse(truncated).parseOk).toBe(false);

        const answered = `{"classifications":[{"index":0,"severity":"low","reason":"cosmetic"}]}\nFormat was: ${reordered}`;
        const { classifications, parseOk } = parseSeverityResponse(answered);
        expect(parseOk).toBe(true);
        expect([...classifications]).toEqual([[0, 'low']]);
    });

    it('fails when no object carries classifications', () => {
        expect(parseSeverityResponse('index 0 is high').parseOk).toBe(false);
        expect(parseSeverityResponse('{"severity": "high"}').parseOk).toBe(false);
        expect(parseSeverityResponse('{"classifications": {"index": 0}}').parseOk).toBe(false);
    });
});
