import { createHash } from 'crypto';

import { ContextReferenceDetectionService } from './context-reference-detection.service';
import type { ContextDependency, ContextDetectionField } from './context-pack';

/**
 * Deterministic core of context-reference detection: the pieces that turn a
 * field/path/dependency into stable ids, hashes, scope paths and knowledge
 * refs. These run on every rule save; a silent regression here corrupts the
 * revision key (dedup breaks), the scope tree (cross-tenant leak), or the
 * cheap gate that decides whether the expensive LLM detection runs at all.
 * Every branch and boundary below is pinned so a plausible mutant fails.
 *
 * Heavy NestJS deps (promptContextEngine, contextReferenceService) are never
 * touched by these methods, so they are inert `{}` stubs. Private/protected
 * members are reached through an `any` cast.
 */
describe('ContextReferenceDetectionService — deterministic logic', () => {
    const service = new ContextReferenceDetectionService({} as any, {} as any);
    const svc = service as any;

    describe('calculateEntityHash', () => {
        it('returns the exact sha256 hex digest of the input', () => {
            expect(svc.calculateEntityHash('hello')).toBe(
                '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
            );
        });

        it('hashes the empty string to the canonical sha256 empty digest', () => {
            expect(svc.calculateEntityHash('')).toBe(
                'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            );
        });

        it('is deterministic and input-sensitive', () => {
            const a = svc.calculateEntityHash('same');
            const b = svc.calculateEntityHash('same');
            const c = svc.calculateEntityHash('diff');
            expect(a).toBe(b);
            expect(a).not.toBe(c);
            // matches the reference implementation exactly
            expect(a).toBe(createHash('sha256').update('same').digest('hex'));
        });
    });

    describe('buildPathKey', () => {
        it('joins path segments with a dot', () => {
            expect(svc.buildPathKey(['a', 'b', 'c'])).toBe('a.b.c');
        });

        it('returns the single segment unchanged when path has one element', () => {
            expect(svc.buildPathKey(['solo'])).toBe('solo');
        });

        it('returns empty string for an empty array', () => {
            expect(svc.buildPathKey([])).toBe('');
        });

        it('returns empty string for undefined/null path (guard)', () => {
            expect(svc.buildPathKey(undefined)).toBe('');
            expect(svc.buildPathKey(null)).toBe('');
        });
    });

    describe('resolveFieldKey', () => {
        it('uses fieldId when defined, trimmed', () => {
            const field = {
                fieldId: '  my-field  ',
                path: ['ignored', 'path'],
            } as ContextDetectionField;
            expect(svc.resolveFieldKey(field)).toBe('my-field');
        });

        it('returns an empty string when fieldId is an empty string (defined but blank), NOT the path', () => {
            // fieldId === '' is `!== undefined`, so the path branch must not run.
            const field = {
                fieldId: '',
                path: ['a', 'b'],
            } as ContextDetectionField;
            expect(svc.resolveFieldKey(field)).toBe('');
        });

        it('falls back to the joined path when fieldId is undefined', () => {
            const field = {
                path: ['x', 'y', 'z'],
            } as ContextDetectionField;
            expect(svc.resolveFieldKey(field)).toBe('x.y.z');
        });

        it('falls back to empty string when fieldId undefined and path empty', () => {
            const field = { path: [] } as ContextDetectionField;
            expect(svc.resolveFieldKey(field)).toBe('');
        });
    });

    describe('extractKnowledgeRefs', () => {
        it('skips dependencies whose type is not "knowledge"', () => {
            const deps: ContextDependency[] = [
                { type: 'tool', id: 'repo|file.ts' },
                { type: 'mcp', id: 'repo|other.ts' },
            ];
            expect(svc.extractKnowledgeRefs(deps)).toEqual([]);
        });

        it('uses the dependency id as itemId when it already contains a pipe', () => {
            const deps: ContextDependency[] = [
                {
                    type: 'knowledge',
                    id: 'repo-123|src/a.ts',
                    metadata: { repositoryId: 'other', filePath: 'src/b.ts' },
                },
            ];
            expect(svc.extractKnowledgeRefs(deps)).toEqual([
                { itemId: 'repo-123|src/a.ts', version: undefined },
            ]);
        });

        it('builds itemId from repositoryId + filePath when id has no pipe', () => {
            const deps: ContextDependency[] = [
                {
                    type: 'knowledge',
                    id: 'nopipe',
                    metadata: { repositoryId: 'repoId', filePath: 'src/a.ts' },
                },
            ];
            expect(svc.extractKnowledgeRefs(deps)).toEqual([
                { itemId: 'repoId|src/a.ts', version: undefined },
            ]);
        });

        it('prefers repositoryId over repositoryName in the itemId', () => {
            const deps: ContextDependency[] = [
                {
                    type: 'knowledge',
                    id: 'nopipe',
                    metadata: {
                        repositoryId: 'theId',
                        repositoryName: 'theName',
                        filePath: 'f.ts',
                    },
                },
            ];
            expect(svc.extractKnowledgeRefs(deps)[0].itemId).toBe('theId|f.ts');
        });

        it('falls back to repositoryName when repositoryId is absent', () => {
            const deps: ContextDependency[] = [
                {
                    type: 'knowledge',
                    id: 'nopipe',
                    metadata: { repositoryName: 'theName', filePath: 'f.ts' },
                },
            ];
            expect(svc.extractKnowledgeRefs(deps)[0].itemId).toBe(
                'theName|f.ts',
            );
        });

        it('falls back to "unknown" when neither repositoryId nor repositoryName is present', () => {
            const deps: ContextDependency[] = [
                {
                    type: 'knowledge',
                    id: 'nopipe',
                    metadata: { filePath: 'f.ts' },
                },
            ];
            expect(svc.extractKnowledgeRefs(deps)[0].itemId).toBe(
                'unknown|f.ts',
            );
        });

        it('uses the string id as filePath when metadata.filePath is missing', () => {
            const deps: ContextDependency[] = [
                {
                    type: 'knowledge',
                    id: 'src/from-id.ts',
                    metadata: { repositoryId: 'repoId' },
                },
            ];
            expect(svc.extractKnowledgeRefs(deps)[0].itemId).toBe(
                'repoId|src/from-id.ts',
            );
        });

        it('uses "unknown" as filePath when id is not a string and metadata.filePath is missing', () => {
            const deps: ContextDependency[] = [
                {
                    type: 'knowledge',
                    id: 42 as any,
                    metadata: { repositoryId: 'repoId' },
                },
            ];
            expect(svc.extractKnowledgeRefs(deps)[0].itemId).toBe(
                'repoId|unknown',
            );
        });

        it('reads version from metadata.version', () => {
            const deps: ContextDependency[] = [
                {
                    type: 'knowledge',
                    id: 'r|f.ts',
                    metadata: { version: 'v1', lastContentHash: 'hashX' },
                },
            ];
            expect(svc.extractKnowledgeRefs(deps)[0].version).toBe('v1');
        });

        it('falls back to lastContentHash when version is absent', () => {
            const deps: ContextDependency[] = [
                {
                    type: 'knowledge',
                    id: 'r|f.ts',
                    metadata: { lastContentHash: 'hashX' },
                },
            ];
            expect(svc.extractKnowledgeRefs(deps)[0].version).toBe('hashX');
        });

        it('leaves version undefined when neither version nor lastContentHash present', () => {
            const deps: ContextDependency[] = [
                { type: 'knowledge', id: 'r|f.ts', metadata: {} },
            ];
            expect(svc.extractKnowledgeRefs(deps)[0].version).toBeUndefined();
        });

        it('tolerates a knowledge dependency with no metadata (defaults to {})', () => {
            const deps: ContextDependency[] = [
                { type: 'knowledge', id: 'r|f.ts' },
            ];
            expect(svc.extractKnowledgeRefs(deps)).toEqual([
                { itemId: 'r|f.ts', version: undefined },
            ]);
        });

        it('preserves order and processes only knowledge deps in a mixed list', () => {
            const deps: ContextDependency[] = [
                { type: 'tool', id: 'skip1' },
                {
                    type: 'knowledge',
                    id: 'a|1.ts',
                    metadata: { version: 'va' },
                },
                { type: 'workflow', id: 'skip2' },
                {
                    type: 'knowledge',
                    id: 'nopipe',
                    metadata: { repositoryId: 'b', filePath: '2.ts' },
                },
            ];
            expect(svc.extractKnowledgeRefs(deps)).toEqual([
                { itemId: 'a|1.ts', version: 'va' },
                { itemId: 'b|2.ts', version: undefined },
            ]);
        });
    });

    describe('buildScopePath', () => {
        it('always starts with the organization level', () => {
            expect(svc.buildScopePath('organization', 'org-1')).toEqual([
                { level: 'organization', id: 'org-1' },
            ]);
        });

        it('appends the team level when teamId is provided', () => {
            expect(
                svc.buildScopePath('organization', 'org-1', 'team-9'),
            ).toEqual([
                { level: 'organization', id: 'org-1' },
                { level: 'team', id: 'team-9' },
            ]);
        });

        it('appends repository only when scopeLevel is "repository" AND repositoryId is present', () => {
            expect(
                svc.buildScopePath('repository', 'org-1', 'team-9', 'repo-7'),
            ).toEqual([
                { level: 'organization', id: 'org-1' },
                { level: 'team', id: 'team-9' },
                { level: 'repository', id: 'repo-7' },
            ]);
        });

        it('does NOT append repository when scopeLevel is "repository" but repositoryId is missing', () => {
            expect(svc.buildScopePath('repository', 'org-1', 'team-9')).toEqual(
                [
                    { level: 'organization', id: 'org-1' },
                    { level: 'team', id: 'team-9' },
                ],
            );
        });

        it('does NOT append repository when repositoryId is present but scopeLevel is not "repository"', () => {
            expect(
                svc.buildScopePath(
                    'organization',
                    'org-1',
                    undefined,
                    'repo-7',
                ),
            ).toEqual([{ level: 'organization', id: 'org-1' }]);
        });

        it('omits the team level when teamId is falsy but still appends repository', () => {
            expect(
                svc.buildScopePath('repository', 'org-1', undefined, 'repo-7'),
            ).toEqual([
                { level: 'organization', id: 'org-1' },
                { level: 'repository', id: 'repo-7' },
            ]);
        });
    });

    describe('hasLikelyExternalReferences', () => {
        it.each([
            ['@file: src/a.ts', '@file[:\\s] marker'],
            ['[[file:src/a.ts]]', '[[file: marker'],
            ['edit @utils.ts', '@name.ext'],
            ['please refer to config.ts', 'refer to ...ext'],
            ['check the thing.md', 'check ...ext'],
            ['see notes.json', 'see ...ext'],
            ['use settings.yml', 'use ...ext'],
            ['read data.txt', 'read ...ext'],
            ['open main.py', 'open ...ext'],
            ['examine module.js', 'examine ...ext'],
            ['a.b.ts', 'dotted name.ext'],
            ['FOO_BAR.ts', 'SCREAMING_CASE.ext'],
            ['see the README', 'well-known doc'],
            ['look in src/', 'src/ path'],
            ['under lib/', 'lib/ path'],
            ['in test/', 'test/ path'],
            ['under docs/', 'docs/ path'],
            ['in config/', 'config/ path'],
            ['run the @mcp tool', '@mcp marker'],
            ['mcp: fetch', 'mcp: marker'],
        ])('returns true for %j (%s)', (text) => {
            expect(svc.hasLikelyExternalReferences(text)).toBe(true);
        });

        it('returns false for prose with no reference-like token', () => {
            expect(
                svc.hasLikelyExternalReferences('just refactor the thing'),
            ).toBe(false);
        });

        it('returns false for the empty string', () => {
            expect(svc.hasLikelyExternalReferences('')).toBe(false);
        });

        it('SCREAMING_CASE match is case-sensitive: lowercase single-dot name is not a reference', () => {
            // foo_bar.ts matches no pattern (the SCREAMING_CASE rule has no /i),
            // while FOO_BAR.ts does — pins the case sensitivity of that branch.
            expect(svc.hasLikelyExternalReferences('foo_bar.ts')).toBe(false);
            expect(svc.hasLikelyExternalReferences('FOO_BAR.ts')).toBe(true);
        });

        it('returns true when only a single pattern matches (kills any .every mutant)', () => {
            // "@mcp" matches exactly one pattern; .some must still return true.
            expect(svc.hasLikelyExternalReferences('@mcp')).toBe(true);
        });
    });
});
