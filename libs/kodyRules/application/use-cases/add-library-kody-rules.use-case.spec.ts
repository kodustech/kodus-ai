import { resolveLibraryRulePath } from './add-library-kody-rules.use-case';

describe('resolveLibraryRulePath (#1832)', () => {
    it('prefers an explicit path over the language-derived glob', () => {
        expect(resolveLibraryRulePath('src/**', 'ruby')).toBe('src/**');
    });

    it('derives a single-extension glob when language is set and path is empty', () => {
        expect(resolveLibraryRulePath(undefined, 'python')).toBe('**/*.py');
        expect(resolveLibraryRulePath('', 'go')).toBe('**/*.go');
    });

    it('derives a brace glob for languages with multiple extensions', () => {
        expect(resolveLibraryRulePath(undefined, 'ruby')).toBe(
            '**/*{.rb,.rake,.erb,.gemspec}',
        );
        expect(resolveLibraryRulePath(undefined, 'typescript')).toBe(
            '**/*{.ts,.tsx}',
        );
    });

    it('keeps an unknown or absent language as-is (empty path → current behaviour)', () => {
        // Unknown language: no glob can be derived, preserve the empty path
        // (the pre-fix behaviour) rather than inventing a scope.
        expect(resolveLibraryRulePath(undefined, 'brainfuck')).toBeUndefined();
        expect(resolveLibraryRulePath(undefined, undefined)).toBeUndefined();
        expect(resolveLibraryRulePath('', undefined)).toBe('');
    });
});
