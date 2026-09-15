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
        expect(resolveLibraryRulePath(undefined, 'kotlin')).toBe(
            '**/*{.kt,.kts}',
        );
    });

    // The library payload carries the `ProgrammingLanguage` keys from
    // apps/web/src/core/enums/programming-language.ts (`jsts` = JS/TS), not the
    // display labels or the `typescript`/`javascript` spellings — an imported
    // JS/TS rule used to miss the table entirely and keep its empty path,
    // applying to every file in every PR (#1832).
    it('resolves the keys the web client actually sends for JS/TS', () => {
        expect(resolveLibraryRulePath(undefined, 'jsts')).toBe(
            '**/*{.js,.jsx,.ts,.tsx}',
        );
        expect(resolveLibraryRulePath(undefined, 'dart')).toBe('**/*.dart');
    });

    it('matches keys case-insensitively and ignores surrounding whitespace', () => {
        expect(resolveLibraryRulePath(undefined, ' Ruby ')).toBe(
            '**/*{.rb,.rake,.erb,.gemspec}',
        );
        expect(resolveLibraryRulePath('', 'JSTS')).toBe(
            '**/*{.js,.jsx,.ts,.tsx}',
        );
    });

    it('still resolves the legacy typescript/javascript spellings', () => {
        // API consumers / older library entries may send these before the
        // client's `jsts` key — they must not silently fall back to an empty
        // path (which re-scopes the rule to every file) (#1832).
        expect(resolveLibraryRulePath(undefined, 'typescript')).toBe(
            '**/*{.ts,.tsx}',
        );
        expect(resolveLibraryRulePath('', 'javascript')).toBe('**/*{.js,.jsx}');
    });

    it('keeps an unknown or absent language as-is (empty path → current behaviour)', () => {
        // Unknown language: no glob can be derived, preserve the empty path
        // (the pre-fix behaviour) rather than inventing a scope.
        expect(resolveLibraryRulePath(undefined, 'brainfuck')).toBeUndefined();
        expect(resolveLibraryRulePath(undefined, undefined)).toBeUndefined();
        expect(resolveLibraryRulePath('', undefined)).toBe('');
    });

    it('treats prototype-shaped languages as unknown instead of crashing', () => {
        // A raw object lookup answered these with `Object`/`Object.prototype`,
        // producing `**/*undefined` (or throwing on `.join`) for a body value
        // the DTO only validates as a string.
        expect(resolveLibraryRulePath(undefined, '__proto__')).toBeUndefined();
        expect(resolveLibraryRulePath('', 'constructor')).toBe('');
        expect(resolveLibraryRulePath(undefined, 'hasOwnProperty')).toBeUndefined();
    });
});
