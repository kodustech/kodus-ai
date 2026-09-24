import { createHash } from 'crypto';

import { PromptContextLoaderService } from './promptContextLoader.service';
import { PromptSourceType } from '@libs/ai-engine/domain/prompt/interfaces/promptExternalReference.interface';

/**
 * Mutation-killing unit tests for the deterministic logic of
 * PromptContextLoaderService.
 *
 * The methods under test (extractLineRange, calculateContentHash,
 * buildContextMap, buildContextLayers) never touch the injected
 * CodeManagementService, so the service is built with an inert stub dependency
 * and the private methods are reached via `(service as any)`.
 */
describe('PromptContextLoaderService (deterministic logic)', () => {
    let service: PromptContextLoaderService;
    const asAny = () => service as any;
    const orgData: any = { organizationId: 'org-1', teamId: 'team-1' };

    beforeEach(() => {
        service = new PromptContextLoaderService({} as any);
    });

    describe('extractLineRange', () => {
        // Five real lines: index 0..4 => 'a','b','c','d','e'
        const content = 'a\nb\nc\nd\ne';

        it('extracts an inclusive interior slice with exact content', () => {
            // start=1 -> Math.max(0, 0)=0 ; end=3 -> Math.min(5, 3)=3
            expect(
                asAny().extractLineRange(
                    content,
                    { start: 1, end: 3 },
                    orgData,
                ),
            ).toBe('a\nb\nc');
        });

        it('extracts an offset slice (start-1 offset is applied)', () => {
            expect(
                asAny().extractLineRange(
                    content,
                    { start: 2, end: 4 },
                    orgData,
                ),
            ).toBe('b\nc\nd');
        });

        it('returns a single line when start === end', () => {
            expect(
                asAny().extractLineRange(
                    content,
                    { start: 2, end: 2 },
                    orgData,
                ),
            ).toBe('b');
        });

        it('clamps end to file length via Math.min (end past EOF)', () => {
            // end=10 -> Math.min(5, 10)=5 ; start=4 -> index 3
            expect(
                asAny().extractLineRange(
                    content,
                    { start: 4, end: 10 },
                    orgData,
                ),
            ).toBe('d\ne');
        });

        it('accepts start exactly at file length (boundary: start > length is false)', () => {
            // 5 lines, start=5 must NOT be rejected; kills the `>` -> `>=` mutant
            expect(
                asAny().extractLineRange(
                    content,
                    { start: 5, end: 5 },
                    orgData,
                ),
            ).toBe('e');
        });

        it('rejects start one past file length (boundary: start > length is true)', () => {
            expect(
                asAny().extractLineRange(
                    content,
                    { start: 6, end: 6 },
                    orgData,
                ),
            ).toBe('');
        });

        it('rejects start === 0 (boundary: start <= 0 is true, kills <=/< mutant)', () => {
            expect(
                asAny().extractLineRange(
                    content,
                    { start: 0, end: 2 },
                    orgData,
                ),
            ).toBe('');
        });

        it('rejects a negative end (end <= 0)', () => {
            expect(
                asAny().extractLineRange(
                    content,
                    { start: 1, end: -1 },
                    orgData,
                ),
            ).toBe('');
        });

        it('rejects an inverted range where start > end', () => {
            expect(
                asAny().extractLineRange(
                    content,
                    { start: 3, end: 2 },
                    orgData,
                ),
            ).toBe('');
        });
    });

    describe('calculateContentHash', () => {
        it('returns the exact sha256 hex digest for a known string', () => {
            const expected = createHash('sha256').update('hello').digest('hex');
            expect(expected).toBe(
                '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
            );
            expect(asAny().calculateContentHash('hello')).toBe(expected);
        });

        it('returns the exact sha256 hex digest for the empty string', () => {
            expect(asAny().calculateContentHash('')).toBe(
                'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            );
        });

        it('produces different digests for different content', () => {
            expect(asAny().calculateContentHash('a')).not.toBe(
                asAny().calculateContentHash('b'),
            );
        });
    });

    describe('buildContextMap', () => {
        it('returns the empty base shape for no references', () => {
            const result = asAny().buildContextMap([], new Map());
            expect(result).toEqual({
                categories: {},
                severity: {},
                generation: {},
            });
        });

        it('places a CATEGORY_BUG reference under categories.bug with merged content', () => {
            const cache = new Map<string, string>([
                ['repo1:a.ts', 'CONTENT_A'],
            ]);
            const refDoc: any = {
                repositoryId: 'ignored-when-name-present',
                sourceType: PromptSourceType.CATEGORY_BUG,
                references: [{ filePath: 'a.ts', repositoryName: 'repo1' }],
            };

            const result = asAny().buildContextMap([refDoc], cache);

            expect(result.categories.bug).toEqual({
                references: [
                    {
                        filePath: 'a.ts',
                        repositoryName: 'repo1',
                        content: 'CONTENT_A',
                    },
                ],
            });
        });

        it('builds the cache key from repositoryId when ref has no repositoryName', () => {
            const cache = new Map<string, string>([
                ['repoID:b.ts', 'CONTENT_B'],
            ]);
            const refDoc: any = {
                repositoryId: 'repoID',
                sourceType: PromptSourceType.CATEGORY_PERFORMANCE,
                references: [{ filePath: 'b.ts' }],
            };

            const result = asAny().buildContextMap([refDoc], cache);

            expect(result.categories.performance).toEqual({
                references: [{ filePath: 'b.ts', content: 'CONTENT_B' }],
            });
        });

        it('drops references whose content is not in the cache (null filtered out)', () => {
            const refDoc: any = {
                repositoryId: 'r',
                sourceType: PromptSourceType.CATEGORY_SECURITY,
                references: [{ filePath: 'missing.ts' }],
            };

            const result = asAny().buildContextMap([refDoc], new Map());

            expect(result.categories.security).toEqual({ references: [] });
        });

        it('joins multiple syncErrors messages with "; " as the error', () => {
            const refDoc: any = {
                repositoryId: 'r',
                sourceType: PromptSourceType.CATEGORY_SECURITY,
                references: [{ filePath: 'c.ts' }],
                syncErrors: [{ message: 'E1' }, { message: 'E2' }],
            };

            const result = asAny().buildContextMap([refDoc], new Map());

            expect(result.categories.security).toEqual({
                references: [],
                error: 'E1; E2',
            });
        });

        it('routes CUSTOM_INSTRUCTION to customInstructions', () => {
            const cache = new Map<string, string>([['r:ci.ts', 'CI']]);
            const refDoc: any = {
                repositoryId: 'r',
                sourceType: PromptSourceType.CUSTOM_INSTRUCTION,
                references: [{ filePath: 'ci.ts' }],
            };

            const result = asAny().buildContextMap([refDoc], cache);

            expect(result.customInstructions).toEqual({
                references: [{ filePath: 'ci.ts', content: 'CI' }],
            });
        });

        it('routes each severity source type to its own bucket', () => {
            const cache = new Map<string, string>([
                ['r:crit.ts', 'C'],
                ['r:high.ts', 'H'],
                ['r:med.ts', 'M'],
                ['r:low.ts', 'L'],
            ]);
            const mk = (
                sourceType: PromptSourceType,
                filePath: string,
            ): any => ({
                repositoryId: 'r',
                sourceType,
                references: [{ filePath }],
            });

            const result = asAny().buildContextMap(
                [
                    mk(PromptSourceType.SEVERITY_CRITICAL, 'crit.ts'),
                    mk(PromptSourceType.SEVERITY_HIGH, 'high.ts'),
                    mk(PromptSourceType.SEVERITY_MEDIUM, 'med.ts'),
                    mk(PromptSourceType.SEVERITY_LOW, 'low.ts'),
                ],
                cache,
            );

            expect(result.severity.critical.references[0].content).toBe('C');
            expect(result.severity.high.references[0].content).toBe('H');
            expect(result.severity.medium.references[0].content).toBe('M');
            expect(result.severity.low.references[0].content).toBe('L');
        });

        it('routes GENERATION_MAIN to generation.main', () => {
            const cache = new Map<string, string>([['r:g.ts', 'G']]);
            const refDoc: any = {
                repositoryId: 'r',
                sourceType: PromptSourceType.GENERATION_MAIN,
                references: [{ filePath: 'g.ts' }],
            };

            const result = asAny().buildContextMap([refDoc], cache);

            expect(result.generation.main).toEqual({
                references: [{ filePath: 'g.ts', content: 'G' }],
            });
        });

        it('ignores source types not handled by the switch (e.g. KODY_RULE)', () => {
            const cache = new Map<string, string>([['r:k.ts', 'K']]);
            const refDoc: any = {
                repositoryId: 'r',
                sourceType: PromptSourceType.KODY_RULE,
                references: [{ filePath: 'k.ts' }],
            };

            const result = asAny().buildContextMap([refDoc], cache);

            expect(result).toEqual({
                categories: {},
                severity: {},
                generation: {},
            });
        });

        it('keeps the first non-empty entry when two docs share a source type (first-wins)', () => {
            const cache = new Map<string, string>([
                ['r:x.ts', 'X'],
                ['r:y.ts', 'Y'],
            ]);
            const first: any = {
                repositoryId: 'r',
                sourceType: PromptSourceType.CATEGORY_BUG,
                references: [{ filePath: 'x.ts' }],
            };
            const second: any = {
                repositoryId: 'r',
                sourceType: PromptSourceType.CATEGORY_BUG,
                references: [{ filePath: 'y.ts' }],
            };

            const result = asAny().buildContextMap([first, second], cache);

            expect(result.categories.bug.references).toHaveLength(1);
            expect(result.categories.bug.references[0].filePath).toBe('x.ts');
            expect(result.categories.bug.references[0].content).toBe('X');
        });

        it('carries a prior error forward onto a later doc that supplies the references', () => {
            const cache = new Map<string, string>([['r:y.ts', 'Y']]);
            const withError: any = {
                repositoryId: 'r',
                sourceType: PromptSourceType.CATEGORY_BUG,
                references: [{ filePath: 'x.ts' }], // not in cache -> no loaded refs
                syncErrors: [{ message: 'ERR' }],
            };
            const withRefs: any = {
                repositoryId: 'r',
                sourceType: PromptSourceType.CATEGORY_BUG,
                references: [{ filePath: 'y.ts' }],
            };

            const result = asAny().buildContextMap(
                [withError, withRefs],
                cache,
            );

            expect(result.categories.bug).toEqual({
                references: [{ filePath: 'y.ts', content: 'Y' }],
                error: 'ERR',
            });
        });
    });

    describe('buildContextLayers', () => {
        it('skips entries with neither content nor errors', () => {
            const entries = [
                {
                    entity: {
                        configKey: 'k',
                        sourceType: PromptSourceType.CATEGORY_BUG,
                        repositoryName: 'r',
                        syncErrors: undefined,
                    } as any,
                    loadedReferences: [],
                },
            ];

            expect(asAny().buildContextLayers(entries)).toEqual([]);
        });

        it('emits a layer for an entry that has only errors (no content)', () => {
            const entries = [
                {
                    entity: {
                        configKey: 'k1',
                        sourceType: PromptSourceType.CATEGORY_BUG,
                        repositoryName: 'r',
                        syncErrors: [{ message: 'boom' }],
                    } as any,
                    loadedReferences: [],
                },
            ];

            const layers = asAny().buildContextLayers(entries);

            expect(layers).toHaveLength(1);
            expect(layers[0].id).toBe('prompt-context:k1:category_bug');
            expect(layers[0].kind).toBe('catalog');
            expect(layers[0].priority).toBe(2);
            expect(layers[0].tokens).toBe(0);
            expect(layers[0].references).toEqual([]);
            expect((layers[0].content as any).syncErrors).toEqual([
                { message: 'boom' },
            ]);
        });

        it('builds a fully populated layer with exact token count, ids and metadata', () => {
            const entity: any = {
                configKey: 'cfg',
                sourceType: PromptSourceType.CATEGORY_PERFORMANCE,
                repositoryName: 'entRepo',
                processingStatus: 'completed',
                contextReferenceId: 'ctx-ref-1',
                contextRequirementsHash: 'hash-1',
                syncErrors: undefined,
            };
            const loadedReferences = [
                {
                    filePath: 'f1.ts',
                    repositoryName: 'repoA',
                    lineRange: { start: 1, end: 2 },
                    description: 'desc1',
                    originalText: 'orig1',
                    content: 'abcdefgh', // 8 chars -> ceil(8/4) = 2 tokens
                },
                {
                    filePath: 'f2.ts',
                    // no repositoryName -> falls back to entity.repositoryName
                    content: 'xyz', // 3 chars -> ceil(3/4) = 1 token
                },
            ] as any;

            const layers = asAny().buildContextLayers([
                { entity, loadedReferences },
            ]);

            expect(layers).toHaveLength(1);
            const layer = layers[0];

            // token sum uses Math.ceil per reference: 2 + 1 = 3
            expect(layer.tokens).toBe(3);
            expect(layer.id).toBe('prompt-context:cfg:category_performance');
            expect(layer.kind).toBe('catalog');
            expect(layer.priority).toBe(2);

            // references itemId: repositoryName ?? entity.repositoryName, plus index
            expect(layer.references).toEqual([
                { itemId: 'repoA:f1.ts:0' },
                { itemId: 'entRepo:f2.ts:1' },
            ]);

            expect(layer.content).toEqual({
                configKey: 'cfg',
                sourceType: PromptSourceType.CATEGORY_PERFORMANCE,
                references: [
                    {
                        filePath: 'f1.ts',
                        repositoryName: 'repoA',
                        lineRange: { start: 1, end: 2 },
                        description: 'desc1',
                        originalText: 'orig1',
                        content: 'abcdefgh',
                    },
                    {
                        filePath: 'f2.ts',
                        repositoryName: 'entRepo',
                        lineRange: undefined,
                        description: undefined,
                        originalText: undefined,
                        content: 'xyz',
                    },
                ],
                syncErrors: undefined,
            });

            expect(layer.metadata).toEqual({
                configKey: 'cfg',
                sourceType: PromptSourceType.CATEGORY_PERFORMANCE,
                processingStatus: 'completed',
                contextReferenceId: 'ctx-ref-1',
                contextRequirementsHash: 'hash-1',
            });
        });

        it('processes multiple entries and preserves their order', () => {
            const mk = (configKey: string): any => ({
                entity: {
                    configKey,
                    sourceType: PromptSourceType.GENERATION_MAIN,
                    repositoryName: 'r',
                    syncErrors: undefined,
                },
                loadedReferences: [{ filePath: 'f.ts', content: 'aaaa' }],
            });

            const layers = asAny().buildContextLayers([
                mk('first'),
                mk('second'),
            ]);

            expect(layers.map((l: any) => l.id)).toEqual([
                'prompt-context:first:generation_main',
                'prompt-context:second:generation_main',
            ]);
        });
    });
});
