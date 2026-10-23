import { V2_DEFAULT_SEVERITY_FLAGS_TEXT } from '@libs/common/utils/codeReview/v2Defaults';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';
import {
    DEFAULT_SEVERITY_FLAGS,
    buildSeverityPrompt,
    hasCustomSeverityFlags,
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
