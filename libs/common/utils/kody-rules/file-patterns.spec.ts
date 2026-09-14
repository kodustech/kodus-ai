import {
    isIdeRuleSource,
    RULE_FILE_PATTERNS,
    extensionScopeAppliesToFile,
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

// The single predicate both the mechanical router and the semantic judge
// narrow by. Nothing below enumerates a language: only the SHAPE is checked,
// so a technology nobody anticipated works the day a rule names it.
describe('extensionScopeAppliesToFile — a rule\'s own language scope', () => {
    it('applies everywhere when the rule declares no scope', () => {
        expect(extensionScopeAppliesToFile('any/path.rb')).toBe(true);
        expect(extensionScopeAppliesToFile('any/path.rb', [])).toBe(true);
    });

    it('narrows to the declared kinds', () => {
        expect(extensionScopeAppliesToFile('app/models/user.rb', ['.rb'])).toBe(
            true,
        );
        expect(extensionScopeAppliesToFile('src/app.tsx', ['.rb'])).toBe(false);
    });

    it('is case-insensitive about the path', () => {
        expect(extensionScopeAppliesToFile('App/Models/User.RB', ['.rb'])).toBe(
            true,
        );
    });

    it('matches by suffix, so a broad scope covers a compound name', () => {
        expect(extensionScopeAppliesToFile('src/a.spec.ts', ['.ts'])).toBe(true);
        expect(extensionScopeAppliesToFile('views/x.blade.php', ['.php'])).toBe(
            true,
        );
    });

    it('lets a rule scope itself to ONLY the compound kind', () => {
        // The distinction a last-segment comparison cannot express, and the one
        // "this does not apply to tests" needs.
        expect(extensionScopeAppliesToFile('src/a.spec.ts', ['.spec.ts'])).toBe(
            true,
        );
        expect(extensionScopeAppliesToFile('src/a.ts', ['.spec.ts'])).toBe(
            false,
        );
    });

    it('does not confuse a shorter extension with the tail of a longer one', () => {
        // "app.mjs" ends in "mjs", not in ".js" — the dot is compared too.
        expect(extensionScopeAppliesToFile('app.mjs', ['.js'])).toBe(false);
        expect(extensionScopeAppliesToFile('app.min.js', ['.js'])).toBe(true);
    });

    it('ABSTAINS on an extensionless file instead of excluding it', () => {
        // Rakefile/Gemfile/Dockerfile/Makefile: we cannot tell the language, and
        // excluding them would be a silent enforcement loss — the rule would
        // never fire there and nothing would report it.
        for (const f of ['Rakefile', 'Gemfile', 'Dockerfile', 'LICENSE']) {
            expect(extensionScopeAppliesToFile(f, ['.rb'])).toBe(true);
        }
        // A dot in a DIRECTORY name is not an extension.
        expect(extensionScopeAppliesToFile('src/v1.2/Makefile', ['.rb'])).toBe(
            true,
        );
    });
});
