import {
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

// EE services pull `@libs/ee/configs/environment`, which is gitignored (copied
// from environment.dev.ts for local builds) — mock it so the suite runs anywhere.
jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: false, API_DEVELOPMENT_MODE: false },
}));

import { KodyRulesValidationService } from './kody-rules-validation.service';

/**
 * Deterministic pure-logic units of KodyRulesValidationService: ordering,
 * de-duplication, glob/path matching and context/rule level resolution.
 *
 * These are the primitives the review pipeline uses to decide which rules
 * apply to a file/folder. The permission dependency is inert ({} as any) —
 * none of the methods under test touch it. Private/protected members are
 * reached via `(service as any)`.
 */
describe('KodyRulesValidationService — deterministic logic', () => {
    let service: KodyRulesValidationService;

    beforeEach(() => {
        service = new KodyRulesValidationService({} as any);
    });

    const call = (method: string, ...args: any[]) =>
        (service as any)[method](...args);

    describe('orderByCreatedAtAndLimit', () => {
        it('orders ascending by createdAt (oldest first)', () => {
            const items = [
                { id: 'b', createdAt: '2021-01-01T00:00:00Z' },
                { id: 'a', createdAt: '2020-01-01T00:00:00Z' },
                { id: 'c', createdAt: '2022-01-01T00:00:00Z' },
            ];
            const result = call('orderByCreatedAtAndLimit', items, 0, 'asc');
            expect(result.map((r: any) => r.id)).toEqual(['a', 'b', 'c']);
        });

        it('orders descending by createdAt (newest first)', () => {
            const items = [
                { id: 'b', createdAt: '2021-01-01T00:00:00Z' },
                { id: 'a', createdAt: '2020-01-01T00:00:00Z' },
                { id: 'c', createdAt: '2022-01-01T00:00:00Z' },
            ];
            const result = call('orderByCreatedAtAndLimit', items, 0, 'desc');
            expect(result.map((r: any) => r.id)).toEqual(['c', 'b', 'a']);
        });

        it('defaults to ascending order when order arg is omitted', () => {
            const items = [
                { id: 'late', createdAt: '2023-01-01T00:00:00Z' },
                { id: 'early', createdAt: '2020-01-01T00:00:00Z' },
            ];
            // limit omitted too -> default 0 (no limit)
            const result = call('orderByCreatedAtAndLimit', items);
            expect(result.map((r: any) => r.id)).toEqual(['early', 'late']);
        });

        it('treats missing createdAt as timestamp 0 (sorts first ascending)', () => {
            const items = [
                { id: 'dated', createdAt: '2020-01-01T00:00:00Z' },
                { id: 'undated' }, // no createdAt -> 0
            ];
            const result = call('orderByCreatedAtAndLimit', items, 0, 'asc');
            expect(result.map((r: any) => r.id)).toEqual(['undated', 'dated']);
        });

        it('treats an invalid date string as timestamp 0 (sorts first ascending)', () => {
            const items = [
                { id: 'dated', createdAt: '2020-01-01T00:00:00Z' },
                { id: 'garbage', createdAt: 'not-a-real-date' }, // NaN -> 0
            ];
            const result = call('orderByCreatedAtAndLimit', items, 0, 'asc');
            expect(result.map((r: any) => r.id)).toEqual(['garbage', 'dated']);
        });

        it('applies the limit slice when limit > 0', () => {
            const items = [
                { id: 'a', createdAt: '2020-01-01T00:00:00Z' },
                { id: 'b', createdAt: '2021-01-01T00:00:00Z' },
                { id: 'c', createdAt: '2022-01-01T00:00:00Z' },
            ];
            const result = call('orderByCreatedAtAndLimit', items, 2, 'asc');
            expect(result.map((r: any) => r.id)).toEqual(['a', 'b']);
        });

        it('does NOT limit when limit is 0 (boundary: > 0, not >= 0)', () => {
            const items = [
                { id: 'a', createdAt: '2020-01-01T00:00:00Z' },
                { id: 'b', createdAt: '2021-01-01T00:00:00Z' },
            ];
            const result = call('orderByCreatedAtAndLimit', items, 0, 'asc');
            // A `>=` mutant would slice(0,0) -> [] here.
            expect(result.map((r: any) => r.id)).toEqual(['a', 'b']);
        });

        it('limit of 1 returns exactly one item (boundary n=1)', () => {
            const items = [
                { id: 'a', createdAt: '2020-01-01T00:00:00Z' },
                { id: 'b', createdAt: '2021-01-01T00:00:00Z' },
            ];
            const result = call('orderByCreatedAtAndLimit', items, 1, 'asc');
            expect(result.map((r: any) => r.id)).toEqual(['a']);
        });
    });

    describe('extractUniqueKodyRules', () => {
        it('keeps the FIRST occurrence of each duplicate `rule` value', () => {
            const rules = [
                { uuid: '1', rule: 'no-console' },
                { uuid: '2', rule: 'no-console' }, // duplicate -> dropped
                { uuid: '3', rule: 'use-const' },
            ];
            const result = call('extractUniqueKodyRules', rules);
            expect(result).toEqual([
                { uuid: '1', rule: 'no-console' },
                { uuid: '3', rule: 'use-const' },
            ]);
        });

        it('skips entries without a truthy `rule` property', () => {
            const rules = [
                { uuid: '1', rule: 'keep-me' },
                { uuid: '2' }, // no rule
                { uuid: '3', rule: '' }, // empty rule -> falsy, skipped
                { uuid: '4', rule: 'also-keep' },
            ];
            const result = call('extractUniqueKodyRules', rules);
            expect(result).toEqual([
                { uuid: '1', rule: 'keep-me' },
                { uuid: '4', rule: 'also-keep' },
            ]);
        });

        it('returns an empty array when given an empty array', () => {
            expect(call('extractUniqueKodyRules', [])).toEqual([]);
        });
    });

    describe('isFilePathMatch', () => {
        it('returns true when the filename is null (no specific file)', () => {
            expect(call('isFilePathMatch', { path: 'src/*.ts' }, null)).toBe(
                true,
            );
        });

        it('returns true for a directory-scoped rule regardless of path glob', () => {
            // directoryId set -> path glob is ignored, always matches.
            expect(
                call(
                    'isFilePathMatch',
                    { directoryId: 'dir-1', path: 'docs/*.md' },
                    'src/index.ts',
                ),
            ).toBe(true);
        });

        it('returns true when the rule path is empty/whitespace', () => {
            expect(
                call('isFilePathMatch', { path: '   ' }, 'src/index.ts'),
            ).toBe(true);
        });

        it('returns true when the rule path is missing entirely', () => {
            expect(call('isFilePathMatch', {}, 'src/index.ts')).toBe(true);
        });

        it('returns true when the filename matches the rule glob', () => {
            expect(
                call('isFilePathMatch', { path: 'src/*.ts' }, 'src/index.ts'),
            ).toBe(true);
        });

        it('returns false when the filename does NOT match the rule glob', () => {
            expect(
                call('isFilePathMatch', { path: 'docs/*.md' }, 'src/index.ts'),
            ).toBe(false);
        });

        it('OR-s comma-joined globs (matches if any pattern matches)', () => {
            expect(
                call(
                    'isFilePathMatch',
                    { path: 'docs/*.md, src/*.ts' },
                    'src/index.ts',
                ),
            ).toBe(true);
        });
    });

    describe('isFolderPathMatch', () => {
        it('returns true when the folder is null', () => {
            expect(call('isFolderPathMatch', { path: 'src/*.ts' }, null)).toBe(
                true,
            );
        });

        it('returns true for a directory-scoped rule regardless of path', () => {
            expect(
                call(
                    'isFolderPathMatch',
                    { directoryId: 'dir-1', path: 'other/**' },
                    'src',
                ),
            ).toBe(true);
        });

        it('returns true when the rule path is empty/whitespace', () => {
            expect(call('isFolderPathMatch', { path: '  ' }, 'src')).toBe(true);
        });

        it('returns true when a glob applies to the folder', () => {
            // 'src/app/*.ts' -> base path 'src/app' equals the folder.
            expect(
                call('isFolderPathMatch', { path: 'src/app/*.ts' }, 'src/app'),
            ).toBe(true);
        });

        it('returns false when no glob applies to the folder', () => {
            expect(
                call('isFolderPathMatch', { path: 'docs/app/*.ts' }, 'src'),
            ).toBe(false);
        });
    });

    describe('isFolderGlobMatch', () => {
        it('matches directly via glob (branch A)', () => {
            // '**' matches any folder as a file glob.
            expect(call('isFolderGlobMatch', '**', 'src/app')).toBe(true);
        });

        it('matches when the glob base path is empty (branch B)', () => {
            // getGlobBasePath('**/*.ts') === '' -> true for any folder.
            expect(call('isFolderGlobMatch', '**/*.ts', 'src')).toBe(true);
        });

        it('matches when the base path equals the folder (branch C)', () => {
            // 'src/app/*.ts' does not match 'src/app' as a file, but base
            // path 'src/app' === folder.
            expect(call('isFolderGlobMatch', 'src/app/*.ts', 'src/app')).toBe(
                true,
            );
        });

        it('matches when the folder is an ancestor of the base path (branch D)', () => {
            // base path 'src/app/sub' startsWith 'src/'.
            expect(call('isFolderGlobMatch', 'src/app/sub/*.ts', 'src')).toBe(
                true,
            );
        });

        it('returns false when nothing matches', () => {
            // base path 'docs/app' -> not '', not 'src', not startsWith 'src/'.
            expect(call('isFolderGlobMatch', 'docs/app/*.ts', 'src')).toBe(
                false,
            );
        });
    });

    describe('getGlobBasePath', () => {
        it('returns the non-glob prefix up to the first wildcard segment', () => {
            expect(call('getGlobBasePath', 'src/app/*.ts')).toBe('src/app');
        });

        it('returns empty string when the first segment is a wildcard', () => {
            expect(call('getGlobBasePath', '**/*.ts')).toBe('');
        });

        it('returns the whole path when there is no wildcard', () => {
            expect(call('getGlobBasePath', 'src/app')).toBe('src/app');
        });

        it('strips leading and trailing slashes', () => {
            expect(call('getGlobBasePath', '/src/app/')).toBe('src/app');
        });

        it('breaks at a `?` wildcard character', () => {
            expect(call('getGlobBasePath', 'a/b?c/d')).toBe('a');
        });

        it('breaks at a `[` character class', () => {
            expect(call('getGlobBasePath', 'src/[abc]/x')).toBe('src');
        });

        it('breaks at a `{` brace-expansion character', () => {
            expect(call('getGlobBasePath', 'src/{a,b}/x')).toBe('src');
        });

        it('breaks at a `!` negation character in the first segment', () => {
            expect(call('getGlobBasePath', 'foo!/bar')).toBe('');
        });
    });

    describe('resolveContextLevel', () => {
        it('returns "directory" when directoryId is present', () => {
            expect(
                call('resolveContextLevel', {
                    directoryId: 'dir-1',
                    repositoryId: 'repo-1',
                }),
            ).toBe('directory');
        });

        it('returns "repository" when only repositoryId is present', () => {
            expect(
                call('resolveContextLevel', { repositoryId: 'repo-1' }),
            ).toBe('repository');
        });

        it('returns "global" when neither id is present', () => {
            expect(call('resolveContextLevel', {})).toBe('global');
        });
    });

    describe('resolveRuleLevel', () => {
        it('returns "directory" when the rule has a directoryId', () => {
            expect(
                call('resolveRuleLevel', {
                    directoryId: 'dir-1',
                    repositoryId: 'repo-1',
                }),
            ).toBe('directory');
        });

        it('returns "repository" for a non-global repositoryId', () => {
            expect(call('resolveRuleLevel', { repositoryId: 'repo-1' })).toBe(
                'repository',
            );
        });

        it('returns "global" when repositoryId is the literal "global"', () => {
            expect(call('resolveRuleLevel', { repositoryId: 'global' })).toBe(
                'global',
            );
        });

        it('returns "global" when the rule has no ids', () => {
            expect(call('resolveRuleLevel', {})).toBe('global');
        });

        it('returns "global" for a null rule (optional-chaining guard)', () => {
            expect(call('resolveRuleLevel', null)).toBe('global');
        });
    });

    // Sanity anchor: the enum literals these methods branch on are the real
    // ones, so a rename in the source is caught here too.
    it('uses the canonical enum literals', () => {
        expect(KodyRulesStatus.ACTIVE).toBe('active');
        expect(KodyRulesStatus.PAUSED).toBe('paused');
        expect(KodyRulesType.MEMORY).toBe('memory');
    });
});
