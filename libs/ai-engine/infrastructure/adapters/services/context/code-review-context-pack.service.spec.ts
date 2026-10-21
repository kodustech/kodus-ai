import { createHash } from 'crypto';

import { CodeReviewContextPackService } from './code-review-context-pack.service';
import type { ContextRequirement } from './context-pack';

/**
 * Deterministic core of the code-review context-pack builder: the pure pieces
 * that sanitize author-supplied overrides, group knowledge dependencies,
 * slice line ranges out of fetched files, hash content and resolve a
 * requirement's path. These run on every context-pack build; a silent
 * regression here corrupts the pack fed to the reviewer (marker leaks,
 * duplicate/omitted knowledge, wrong file slices, unstable hashes).
 *
 * The two NestJS deps (contextReferenceService, codeManagementService) are
 * never touched by these methods, so they are inert `{}` stubs. Private
 * members are reached through an `any` cast. Every branch and boundary below
 * is pinned so a plausible mutant fails.
 */
describe('CodeReviewContextPackService — deterministic logic', () => {
    const service = new CodeReviewContextPackService({} as any, {} as any);
    const svc = service as any;

    describe('sanitizeOverrides', () => {
        it('returns undefined for a falsy input (guard clause)', () => {
            expect(svc.sanitizeOverrides(undefined)).toBeUndefined();
        });

        it('strips context markers from strings and preserves mcpMention nodes verbatim', () => {
            const input = {
                a: 'x @mcp<p|t> y',
                b: ['no marker', 'z@mcp<q|r>'],
                c: { type: 'mcpMention', label: 'keep @mcp<x|y>' },
                d: 5,
                e: true,
                f: null,
            };

            const result = svc.sanitizeOverrides(input as any);

            expect(result).toEqual({
                // marker removed, then the double space it left is collapsed
                a: 'x y',
                // arrays are mapped recursively; each string sanitized+trimmed
                b: ['no marker', 'z'],
                // mcpMention subtree is returned untouched — inner marker survives
                c: { type: 'mcpMention', label: 'keep @mcp<x|y>' },
                // non-string primitives pass through unchanged
                d: 5,
                e: true,
                f: null,
            });
        });

        it('returns a deep clone, not the original reference', () => {
            const input = { a: 'clean' };
            const result = svc.sanitizeOverrides(input as any);
            expect(result).not.toBe(input);
        });
    });

    describe('buildDependencyGroups', () => {
        it('collects a knowledge dependency and enriches metadata with path/pathKey/requirementId', () => {
            const requirement = {
                id: 'reqA',
                metadata: { path: ['v2PromptOverrides', 'categories'] },
                dependencies: [
                    {
                        type: 'knowledge',
                        id: 'd1',
                        descriptor: { x: 1 },
                        metadata: {
                            filePath: 'src/a.ts',
                            repositoryName: 'repoX',
                            repositoryId: 'id1',
                            extra: 'keepme',
                        },
                    },
                ],
            } as unknown as ContextRequirement;

            const result = svc.buildDependencyGroups([requirement]);

            expect(result).toEqual([
                {
                    type: 'knowledge',
                    id: 'd1',
                    descriptor: { x: 1 },
                    metadata: {
                        filePath: 'src/a.ts',
                        repositoryName: 'repoX',
                        repositoryId: 'id1',
                        extra: 'keepme',
                        path: ['v2PromptOverrides', 'categories'],
                        pathKey: 'v2PromptOverrides.categories',
                        requirementId: 'reqA',
                    },
                },
            ]);
        });

        it('skips null deps, non-knowledge types and deps without filePath', () => {
            const requirement = {
                id: 'reqA',
                metadata: { path: ['p'] },
                dependencies: [
                    null,
                    { type: 'tool', id: 't1', metadata: { filePath: 'x.ts' } },
                    { type: 'knowledge', id: 'k1', metadata: {} },
                    {
                        type: 'knowledge',
                        id: 'k2',
                        metadata: { filePath: 'ok.ts' },
                    },
                ],
            } as unknown as ContextRequirement;

            const result = svc.buildDependencyGroups([requirement]);

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('k2');
        });

        it('dedupes by repositoryName::filePath keeping the first occurrence', () => {
            const requirement = {
                id: 'reqA',
                metadata: { path: ['p'] },
                dependencies: [
                    {
                        type: 'knowledge',
                        id: 'first',
                        descriptor: 'FIRST',
                        metadata: { filePath: 'a.ts', repositoryName: 'repoX' },
                    },
                    {
                        type: 'knowledge',
                        id: 'second',
                        descriptor: 'SECOND',
                        metadata: { filePath: 'a.ts', repositoryName: 'repoX' },
                    },
                ],
            } as unknown as ContextRequirement;

            const result = svc.buildDependencyGroups([requirement]);

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('first');
            expect(result[0].descriptor).toBe('FIRST');
        });

        it('falls back to repositoryId then "default" for the dedupe key and to knowledgeKey for the id', () => {
            const requirement = {
                id: 'root#a.b',
                dependencies: [
                    // no repositoryName -> uses repositoryId in the key
                    {
                        type: 'knowledge',
                        id: 'byId',
                        metadata: { filePath: 'a.ts', repositoryId: 'rid' },
                    },
                    // no name, no id, empty dep id -> key uses 'default', id falls back to knowledgeKey
                    {
                        type: 'knowledge',
                        id: '',
                        metadata: { filePath: 'b.ts' },
                    },
                ],
            } as unknown as ContextRequirement;

            const result = svc.buildDependencyGroups([requirement]);

            expect(result).toHaveLength(2);

            expect(result[0].id).toBe('byId');
            expect(result[0].metadata.repositoryId).toBe('rid');
            expect(result[0].metadata.repositoryName).toBeUndefined();

            // empty dep id -> knowledgeKey = `default::b.ts`
            expect(result[1].id).toBe('default::b.ts');
            // derived path from id with '#'
            expect(result[1].metadata.path).toEqual(['a', 'b']);
            expect(result[1].metadata.pathKey).toBe('a.b');
            expect(result[1].metadata.requirementId).toBe('root#a.b');
        });

        it('returns an empty array when a requirement has no dependencies', () => {
            const requirement = {
                id: 'reqA',
                metadata: { path: ['p'] },
            } as unknown as ContextRequirement;

            expect(svc.buildDependencyGroups([requirement])).toEqual([]);
        });
    });

    describe('resolveRequirementPath', () => {
        it('returns the metadata.path array when every segment is a string', () => {
            const requirement = {
                id: 'anything#z',
                metadata: { path: ['a', 'b'] },
            } as unknown as ContextRequirement;

            expect(svc.resolveRequirementPath(requirement)).toEqual(['a', 'b']);
        });

        it('honours an empty (but valid) metadata.path array over deriving from id', () => {
            const requirement = {
                id: 'x#y',
                metadata: { path: [] },
            } as unknown as ContextRequirement;

            expect(svc.resolveRequirementPath(requirement)).toEqual([]);
        });

        it('derives from the id when a path segment is not a string', () => {
            const requirement = {
                id: 'root#a.b.c',
                metadata: { path: ['a', 5] },
            } as unknown as ContextRequirement;

            expect(svc.resolveRequirementPath(requirement)).toEqual([
                'a',
                'b',
                'c',
            ]);
        });

        it('derives [id] from an id without a "#"', () => {
            const requirement = {
                id: 'noHash',
            } as unknown as ContextRequirement;

            expect(svc.resolveRequirementPath(requirement)).toEqual(['noHash']);
        });

        it('derives the tail (split on ".") from an id containing "#"', () => {
            const requirement = {
                id: 'prefix#one.two.three',
            } as unknown as ContextRequirement;

            expect(svc.resolveRequirementPath(requirement)).toEqual([
                'one',
                'two',
                'three',
            ]);
        });
    });

    describe('extractLineRange', () => {
        const content = 'L1\nL2\nL3\nL4\nL5';

        it('extracts a single line at the start boundary (1..1)', () => {
            expect(svc.extractLineRange(content, { start: 1, end: 1 })).toBe(
                'L1',
            );
        });

        it('extracts an inner range converting 1-based start to 0-based slice', () => {
            expect(svc.extractLineRange(content, { start: 2, end: 4 })).toBe(
                'L2\nL3\nL4',
            );
        });

        it('extracts the full file when the range spans all lines', () => {
            expect(svc.extractLineRange(content, { start: 1, end: 5 })).toBe(
                content,
            );
        });

        it('extracts the last line when start equals the line count (boundary)', () => {
            expect(svc.extractLineRange(content, { start: 5, end: 5 })).toBe(
                'L5',
            );
        });

        it('returns "" when start exceeds the line count by one (> not >=)', () => {
            expect(svc.extractLineRange(content, { start: 6, end: 6 })).toBe(
                '',
            );
        });

        it('clamps end to the file length', () => {
            expect(svc.extractLineRange(content, { start: 4, end: 100 })).toBe(
                'L4\nL5',
            );
        });

        it('returns "" when start <= 0 (boundary 0)', () => {
            expect(svc.extractLineRange(content, { start: 0, end: 2 })).toBe(
                '',
            );
        });

        it('returns "" when end <= 0 (boundary 0)', () => {
            expect(svc.extractLineRange(content, { start: 1, end: 0 })).toBe(
                '',
            );
        });

        it('returns "" when start > end (inverted range)', () => {
            expect(svc.extractLineRange(content, { start: 3, end: 2 })).toBe(
                '',
            );
        });
    });

    describe('calculateContentHash', () => {
        it('returns the exact sha256 hex digest of the input', () => {
            const expected = createHash('sha256')
                .update('hello world')
                .digest('hex');
            expect(svc.calculateContentHash('hello world')).toBe(expected);
            expect(svc.calculateContentHash('hello world')).toHaveLength(64);
        });

        it('produces different digests for different content', () => {
            expect(svc.calculateContentHash('a')).not.toBe(
                svc.calculateContentHash('b'),
            );
        });

        it('hashes the empty string to the known sha256 constant', () => {
            expect(svc.calculateContentHash('')).toBe(
                'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            );
        });
    });
});
