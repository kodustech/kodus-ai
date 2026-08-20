import {
    isIdeRuleSource,
    RULE_FILE_PATTERNS,
    extractRepoSubdirFromIdeSource,
} from './file-patterns';

describe('file-patterns — .agents/rules discovery', () => {
    it('ships the .agents/rules/** pattern in RULE_FILE_PATTERNS', () => {
        expect(RULE_FILE_PATTERNS).toContain('.agents/rules/**');
    });

    it('recognises repo-root .agents/rules files as IDE rule sources', () => {
        expect(isIdeRuleSource('.agents/rules/architecture.md')).toBe(true);
    });

    it('recognises nested .agents/rules files (monorepo subdir)', () => {
        expect(
            isIdeRuleSource('applications/sales/.agents/rules/style.md'),
        ).toBe(true);
    });

    it('scopes a nested .agents/rules source to its repo subdir', () => {
        expect(
            extractRepoSubdirFromIdeSource(
                'applications/sales/.agents/rules/style.md',
            ),
        ).toBe('applications/sales');
    });

    it('treats a repo-root .agents/rules file as repo-wide', () => {
        expect(extractRepoSubdirFromIdeSource('.agents/rules/style.md')).toBe(
            null,
        );
    });
});
