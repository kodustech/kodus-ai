import { PromptExternalReferenceManagerService } from './promptExternalReferenceManager.service';
import {
    PromptProcessingStatus,
    PromptReferenceErrorType,
    PromptSourceType,
} from '@libs/ai-engine/domain/prompt/interfaces/promptExternalReference.interface';
import { computeRequirementsHash } from '@libs/ai-engine/infrastructure/adapters/services/context/context-pack';

/**
 * Mutation-killing unit tests for the deterministic logic of
 * PromptExternalReferenceManagerService. The service methods under test do not
 * touch the injected ContextReferenceService, so we construct it with an inert
 * stub dependency and reach the private methods via `(service as any)`.
 */
describe('PromptExternalReferenceManagerService (deterministic logic)', () => {
    let service: PromptExternalReferenceManagerService;
    const asAny = () => service as any;

    beforeEach(() => {
        service = new PromptExternalReferenceManagerService({} as any);
    });

    describe('normalizeRepositoryId', () => {
        it('returns undefined for undefined input', () => {
            expect(asAny().normalizeRepositoryId(undefined)).toBeUndefined();
        });

        it('returns undefined for empty string (falsy guard)', () => {
            expect(asAny().normalizeRepositoryId('')).toBeUndefined();
        });

        it('returns undefined for the literal "global"', () => {
            expect(asAny().normalizeRepositoryId('global')).toBeUndefined();
        });

        it('returns the id unchanged for a real repository id', () => {
            expect(asAny().normalizeRepositoryId('repo-123')).toBe('repo-123');
        });

        it('does not treat a "global"-containing id as global', () => {
            expect(asAny().normalizeRepositoryId('global-2')).toBe('global-2');
        });
    });

    describe('normalizeToolKey', () => {
        it('returns undefined for undefined', () => {
            expect(asAny().normalizeToolKey(undefined)).toBeUndefined();
        });

        it('returns undefined for null', () => {
            expect(asAny().normalizeToolKey(null)).toBeUndefined();
        });

        it('returns undefined for empty string (falsy guard)', () => {
            expect(asAny().normalizeToolKey('')).toBeUndefined();
        });

        it('trims, lowercases and strips non-alphanumerics', () => {
            expect(asAny().normalizeToolKey('  Foo-Bar_123 ')).toBe(
                'foobar123',
            );
        });

        it('returns undefined when nothing alphanumeric survives normalization', () => {
            expect(asAny().normalizeToolKey('-_!@#')).toBeUndefined();
        });

        it('lowercases plain letters', () => {
            expect(asAny().normalizeToolKey('ABC')).toBe('abc');
        });
    });

    describe('isPromptSourceType', () => {
        it('returns true for a real enum member value', () => {
            expect(asAny().isPromptSourceType('kody_rule')).toBe(true);
        });

        it('returns true for another enum member value', () => {
            expect(asAny().isPromptSourceType('custom_instruction')).toBe(true);
        });

        it('returns false for a non-member string', () => {
            expect(asAny().isPromptSourceType('not_a_source')).toBe(false);
        });

        it('returns false for an enum key name (not value)', () => {
            expect(asAny().isPromptSourceType('KODY_RULE')).toBe(false);
        });
    });

    describe('parseEntityIdFormat', () => {
        it('parses org/team/repo/dir into an exact ParsedConfigKey', () => {
            const key = 'org:O1/team:T1/repo:R1/dir:D1';
            expect(asAny().parseEntityIdFormat(key)).toEqual({
                organizationAndTeamData: {
                    organizationId: 'O1',
                    teamId: 'T1',
                },
                repositoryId: 'R1',
                repositoryName: 'R1',
                directoryId: 'D1',
                configKey: key,
                entityId: key,
            });
        });

        it('defaults repository to "global" when the repo segment is empty', () => {
            const key = 'org:O1/repo:';
            const parsed = asAny().parseEntityIdFormat(key);
            expect(parsed.repositoryId).toBe('global');
            expect(parsed.repositoryName).toBe('global');
            expect(parsed.directoryId).toBeUndefined();
            expect(parsed.organizationAndTeamData).toEqual({
                organizationId: 'O1',
                teamId: undefined,
            });
        });

        it('defaults repository to "global" when there is no repo segment', () => {
            const parsed = asAny().parseEntityIdFormat('org:O1/team:T1');
            expect(parsed.repositoryId).toBe('global');
            expect(parsed.repositoryName).toBe('global');
            expect(parsed.organizationAndTeamData.teamId).toBe('T1');
        });

        it('leaves organizationId empty when no org segment is present', () => {
            const parsed = asAny().parseEntityIdFormat('repo:R9');
            expect(parsed.organizationAndTeamData.organizationId).toBe('');
            expect(parsed.repositoryId).toBe('R9');
        });
    });

    describe('parseLegacyFormat', () => {
        it('parses org:repo:dir into an exact ParsedConfigKey with composed entityId', () => {
            expect(asAny().parseLegacyFormat('O1:R1:D1')).toEqual({
                organizationAndTeamData: { organizationId: 'O1' },
                repositoryId: 'R1',
                repositoryName: 'R1',
                directoryId: 'D1',
                configKey: 'O1:R1:D1',
                entityId: 'org:O1/repo:R1/dir:D1',
            });
        });

        it('treats "global" repository token as no repository', () => {
            const parsed = asAny().parseLegacyFormat('O1:global');
            expect(parsed.repositoryId).toBe('global');
            expect(parsed.repositoryName).toBe('global');
            expect(parsed.directoryId).toBeUndefined();
            expect(parsed.entityId).toBe('org:O1');
        });

        it('defaults missing repository part to global (single-part key)', () => {
            const parsed = asAny().parseLegacyFormat('O1');
            expect(parsed.repositoryId).toBe('global');
            expect(parsed.entityId).toBe('org:O1');
        });

        it('does not extract a directory when only two parts are present (boundary length === 2)', () => {
            const parsed = asAny().parseLegacyFormat('O1:R1');
            expect(parsed.directoryId).toBeUndefined();
            expect(parsed.entityId).toBe('org:O1/repo:R1');
        });

        it('extracts a directory when three parts are present (boundary length === 3)', () => {
            const parsed = asAny().parseLegacyFormat('O1:R1:D1');
            expect(parsed.directoryId).toBe('D1');
            expect(parsed.entityId).toBe('org:O1/repo:R1/dir:D1');
        });

        it('defaults organizationId to empty string for an empty key', () => {
            const parsed = asAny().parseLegacyFormat('');
            expect(parsed.organizationAndTeamData.organizationId).toBe('');
        });
    });

    describe('parseConfigKey (dispatch by "/" presence)', () => {
        it('routes keys containing "/" to the entity-id parser', () => {
            const parsed = asAny().parseConfigKey('org:O1/repo:R1');
            // entity-id parser keeps configKey === entityId
            expect(parsed.entityId).toBe('org:O1/repo:R1');
            expect(parsed.repositoryId).toBe('R1');
            expect(parsed.organizationAndTeamData.organizationId).toBe('O1');
        });

        it('routes keys without "/" to the legacy parser (composes entityId)', () => {
            const parsed = asAny().parseConfigKey('O1:R1');
            expect(parsed.configKey).toBe('O1:R1');
            // legacy parser composes a distinct entityId
            expect(parsed.entityId).toBe('org:O1/repo:R1');
        });
    });

    describe('selectConfigKeyForRevision', () => {
        const revisionWith = (metadata: Record<string, unknown> | undefined) =>
            ({ metadata }) as any;

        it('returns the matching key by repositoryId, not the first key', () => {
            const keys = ['org:O/repo:R1', 'org:O/repo:R2'];
            const result = asAny().selectConfigKeyForRevision(
                keys,
                revisionWith({ repositoryId: 'R2' }),
            );
            expect(result).toBe('org:O/repo:R2');
        });

        it('requires directoryId to match as well (both conditions)', () => {
            const keys = ['org:O/repo:R1', 'org:O/repo:R1/dir:D1'];
            const result = asAny().selectConfigKeyForRevision(
                keys,
                revisionWith({ repositoryId: 'R1', directoryId: 'D1' }),
            );
            expect(result).toBe('org:O/repo:R1/dir:D1');
        });

        it('falls back to the first key when no candidate matches', () => {
            const keys = ['org:O/repo:R1', 'org:O/repo:R3'];
            const result = asAny().selectConfigKeyForRevision(
                keys,
                revisionWith({ repositoryId: 'R9' }),
            );
            expect(result).toBe('org:O/repo:R1');
        });

        it('defaults revision repository to "global" when metadata is absent', () => {
            // 'org:O/team:T' has no repo segment -> parses to repositoryId 'global'
            const keys = ['org:O/repo:R1', 'org:O/team:T'];
            const result = asAny().selectConfigKeyForRevision(
                keys,
                revisionWith(undefined),
            );
            expect(result).toBe('org:O/team:T');
        });

        it('ignores a non-string repositoryId and defaults to "global"', () => {
            const keys = ['org:O/repo:R1', 'org:O/team:T'];
            const result = asAny().selectConfigKeyForRevision(
                keys,
                revisionWith({ repositoryId: 123 }),
            );
            expect(result).toBe('org:O/team:T');
        });
    });

    describe('resolveSourceType', () => {
        it('returns the explicit metadata sourceType when it is a valid enum value', () => {
            const req = { metadata: { sourceType: 'category_bug' } } as any;
            expect(asAny().resolveSourceType(req)).toBe(
                PromptSourceType.CATEGORY_BUG,
            );
        });

        it('ignores an invalid metadata sourceType and returns undefined without a path', () => {
            const req = { metadata: { sourceType: 'bogus' } } as any;
            expect(asAny().resolveSourceType(req)).toBeUndefined();
        });

        it('falls back to path resolution when sourceType is invalid', () => {
            const req = {
                metadata: {
                    sourceType: 'bogus',
                    path: ['summary', 'customInstructions'],
                },
            } as any;
            expect(asAny().resolveSourceType(req)).toBe(
                PromptSourceType.CUSTOM_INSTRUCTION,
            );
        });

        it('resolves from a known path when there is no sourceType', () => {
            const req = {
                metadata: {
                    path: ['v2PromptOverrides', 'generation', 'main'],
                },
            } as any;
            expect(asAny().resolveSourceType(req)).toBe(
                PromptSourceType.GENERATION_MAIN,
            );
        });

        it('returns undefined for an unknown path', () => {
            const req = { metadata: { path: ['nope', 'nope'] } } as any;
            expect(asAny().resolveSourceType(req)).toBeUndefined();
        });

        it('returns undefined when metadata is absent', () => {
            expect(asAny().resolveSourceType({} as any)).toBeUndefined();
        });

        it('ignores a non-string sourceType and a non-array path', () => {
            const req = {
                metadata: { sourceType: 42, path: 'not-an-array' },
            } as any;
            expect(asAny().resolveSourceType(req)).toBeUndefined();
        });
    });

    describe('mapDependencyError', () => {
        it('returns undefined when no error type is present', () => {
            expect(
                asAny().mapDependencyError({ message: 'x' }),
            ).toBeUndefined();
        });

        it('maps a full error payload exactly', () => {
            const iso = '2026-01-02T03:04:05.000Z';
            const result = asAny().mapDependencyError({
                type: PromptReferenceErrorType.FILE_NOT_FOUND,
                message: 'missing',
                attemptedPatterns: ['a', 'b'],
                timestamp: iso,
            });
            expect(result.type).toBe(PromptReferenceErrorType.FILE_NOT_FOUND);
            expect(result.message).toBe('missing');
            expect(result.attemptedPatterns).toEqual(['a', 'b']);
            expect(result.timestamp).toBeInstanceOf(Date);
            expect(result.timestamp.toISOString()).toBe(iso);
        });

        it('defaults message to empty string and patterns to empty array', () => {
            const result = asAny().mapDependencyError({
                type: PromptReferenceErrorType.FETCH_FAILED,
                message: 123,
                attemptedPatterns: 'not-array',
            });
            expect(result.message).toBe('');
            expect(result.attemptedPatterns).toEqual([]);
        });

        it('defaults timestamp to a Date when no timestamp string is given', () => {
            const result = asAny().mapDependencyError({
                type: PromptReferenceErrorType.DETECTION_FAILED,
            });
            expect(result.timestamp).toBeInstanceOf(Date);
        });
    });

    describe('mapDependencyToReference', () => {
        it('returns undefined when there is no filePath', () => {
            const dep = { type: 'knowledge', id: 'k1', metadata: {} } as any;
            expect(
                asAny().mapDependencyToReference(dep, 'fallback-repo'),
            ).toBeUndefined();
        });

        it('returns undefined when filePath is not a string', () => {
            const dep = {
                type: 'knowledge',
                id: 'k1',
                metadata: { filePath: 12 },
            } as any;
            expect(
                asAny().mapDependencyToReference(dep, 'fallback-repo'),
            ).toBeUndefined();
        });

        it('maps a full metadata payload with all optional fields', () => {
            const detected = '2026-02-01T00:00:00.000Z';
            const validated = '2026-03-01T00:00:00.000Z';
            const dep = {
                type: 'knowledge',
                id: 'k1',
                metadata: {
                    filePath: 'src/a.ts',
                    repositoryName: 'my-repo',
                    description: 'a desc',
                    originalText: 'orig',
                    lineRange: { start: 3, end: 9 },
                    detectedAt: detected,
                    lastValidatedAt: validated,
                    lastContentHash: 'hash123',
                    estimatedTokens: 42,
                },
            } as any;

            const ref = asAny().mapDependencyToReference(dep, 'fallback-repo');
            expect(ref.filePath).toBe('src/a.ts');
            expect(ref.repositoryName).toBe('my-repo');
            expect(ref.description).toBe('a desc');
            expect(ref.originalText).toBe('orig');
            expect(ref.lineRange).toEqual({ start: 3, end: 9 });
            expect(ref.lastContentHash).toBe('hash123');
            expect(ref.estimatedTokens).toBe(42);
            expect(ref.lastValidatedAt).toBeInstanceOf(Date);
            expect(ref.lastValidatedAt.toISOString()).toBe(validated);
            expect(ref.lastFetchError).toBeUndefined();
        });

        it('uses the fallback repository name when metadata omits it', () => {
            const dep = {
                type: 'knowledge',
                id: 'k1',
                metadata: { filePath: 'src/a.ts' },
            } as any;
            const ref = asAny().mapDependencyToReference(dep, 'fallback-repo');
            expect(ref.repositoryName).toBe('fallback-repo');
        });

        it('omits lineRange when only start is present (both-ends required)', () => {
            const dep = {
                type: 'knowledge',
                id: 'k1',
                metadata: { filePath: 'src/a.ts', lineRange: { start: 3 } },
            } as any;
            const ref = asAny().mapDependencyToReference(dep, 'fallback-repo');
            expect(ref.lineRange).toBeUndefined();
        });

        it('omits lineRange when only end is present', () => {
            const dep = {
                type: 'knowledge',
                id: 'k1',
                metadata: { filePath: 'src/a.ts', lineRange: { end: 9 } },
            } as any;
            const ref = asAny().mapDependencyToReference(dep, 'fallback-repo');
            expect(ref.lineRange).toBeUndefined();
        });

        it('defaults lastValidatedAt to detectedAt when lastValidatedAt is absent', () => {
            const detected = '2026-02-01T00:00:00.000Z';
            const dep = {
                type: 'knowledge',
                id: 'k1',
                metadata: { filePath: 'src/a.ts', detectedAt: detected },
            } as any;
            const ref = asAny().mapDependencyToReference(dep, 'fallback-repo');
            expect(ref.lastValidatedAt.toISOString()).toBe(detected);
        });

        it('defaults lastContentHash to empty string and estimatedTokens to undefined', () => {
            const dep = {
                type: 'knowledge',
                id: 'k1',
                metadata: { filePath: 'src/a.ts', estimatedTokens: 'x' },
            } as any;
            const ref = asAny().mapDependencyToReference(dep, 'fallback-repo');
            expect(ref.lastContentHash).toBe('');
            expect(ref.estimatedTokens).toBeUndefined();
        });

        it('maps a nested lastFetchError through mapDependencyError', () => {
            const dep = {
                type: 'knowledge',
                id: 'k1',
                metadata: {
                    filePath: 'src/a.ts',
                    lastFetchError: {
                        type: PromptReferenceErrorType.FILE_TOO_LARGE,
                        message: 'too big',
                        attemptedPatterns: ['p'],
                    },
                },
            } as any;
            const ref = asAny().mapDependencyToReference(dep, 'fallback-repo');
            expect(ref.lastFetchError.type).toBe(
                PromptReferenceErrorType.FILE_TOO_LARGE,
            );
            expect(ref.lastFetchError.message).toBe('too big');
            expect(ref.lastFetchError.attemptedPatterns).toEqual(['p']);
        });
    });

    describe('mapRevisionToReferences', () => {
        const parsedKey = {
            organizationAndTeamData: { organizationId: 'ORG1' },
            repositoryId: 'REPO1',
            repositoryName: 'REPO1',
            directoryId: 'DIR1',
            configKey: 'ORG1:REPO1:DIR1',
            entityId: 'org:ORG1/repo:REPO1/dir:DIR1',
        };

        const knowledgeDep = (filePath: string) => ({
            type: 'knowledge',
            id: `dep-${filePath}`,
            metadata: { filePath },
        });

        it('returns an empty array when the revision has no requirements', () => {
            const revision = { uuid: 'rev-1', requirements: [] } as any;
            expect(
                asAny().mapRevisionToReferences(revision, parsedKey),
            ).toEqual([]);
        });

        it('returns an empty array when requirements is undefined', () => {
            const revision = { uuid: 'rev-1' } as any;
            expect(
                asAny().mapRevisionToReferences(revision, parsedKey),
            ).toEqual([]);
        });

        it('builds a COMPLETED entity with fields copied from the parsed key and revision', () => {
            const requirements = [
                {
                    id: 'req-1',
                    metadata: {
                        sourceType: PromptSourceType.CATEGORY_BUG,
                        promptHash: 'ph-1',
                    },
                    dependencies: [knowledgeDep('src/a.ts')],
                },
            ];
            const revision = {
                uuid: 'rev-1',
                requirements,
                createdAt: new Date('2026-01-01T00:00:00.000Z'),
                updatedAt: new Date('2026-01-02T00:00:00.000Z'),
            } as any;

            const result = asAny().mapRevisionToReferences(revision, parsedKey);
            expect(result).toHaveLength(1);
            const entity = result[0];
            expect(entity.sourceType).toBe(PromptSourceType.CATEGORY_BUG);
            expect(entity.configKey).toBe('ORG1:REPO1:DIR1');
            expect(entity.organizationId).toBe('ORG1');
            expect(entity.repositoryId).toBe('REPO1');
            expect(entity.directoryId).toBe('DIR1');
            expect(entity.repositoryName).toBe('REPO1');
            expect(entity.promptHash).toBe('ph-1');
            expect(entity.contextReferenceId).toBe('rev-1');
            expect(entity.contextRequirementsHash).toBe(
                computeRequirementsHash(requirements as any),
            );
            expect(entity.processingStatus).toBe(
                PromptProcessingStatus.COMPLETED,
            );
            expect(entity.references).toHaveLength(1);
            expect(entity.references[0].filePath).toBe('src/a.ts');
        });

        it('defaults promptHash to empty string when metadata lacks it', () => {
            const requirements = [
                {
                    id: 'req-1',
                    metadata: { sourceType: PromptSourceType.CATEGORY_BUG },
                    dependencies: [knowledgeDep('src/a.ts')],
                },
            ];
            const revision = { uuid: 'rev-1', requirements } as any;
            const [entity] = asAny().mapRevisionToReferences(
                revision,
                parsedKey,
            );
            expect(entity.promptHash).toBe('');
        });

        it('marks the entity FAILED when the requirement status is draft', () => {
            const requirements = [
                {
                    id: 'req-1',
                    status: 'draft',
                    metadata: { sourceType: PromptSourceType.CATEGORY_BUG },
                    dependencies: [knowledgeDep('src/a.ts')],
                },
            ];
            const revision = { uuid: 'rev-1', requirements } as any;
            const [entity] = asAny().mapRevisionToReferences(
                revision,
                parsedKey,
            );
            expect(entity.processingStatus).toBe(PromptProcessingStatus.FAILED);
        });

        it('marks the entity FAILED when there are sync errors and no references', () => {
            const requirements = [
                {
                    id: 'req-1',
                    metadata: {
                        sourceType: PromptSourceType.CATEGORY_BUG,
                        syncErrors: [
                            {
                                type: PromptReferenceErrorType.FETCH_FAILED,
                                message: 'boom',
                            },
                        ],
                    },
                    dependencies: [],
                },
            ];
            const revision = { uuid: 'rev-1', requirements } as any;
            const [entity] = asAny().mapRevisionToReferences(
                revision,
                parsedKey,
            );
            expect(entity.processingStatus).toBe(PromptProcessingStatus.FAILED);
        });

        it('stays COMPLETED when there are sync errors but references exist (AND, not OR)', () => {
            const requirements = [
                {
                    id: 'req-1',
                    metadata: {
                        sourceType: PromptSourceType.CATEGORY_BUG,
                        syncErrors: [
                            {
                                type: PromptReferenceErrorType.FETCH_FAILED,
                                message: 'boom',
                            },
                        ],
                    },
                    dependencies: [knowledgeDep('src/a.ts')],
                },
            ];
            const revision = { uuid: 'rev-1', requirements } as any;
            const [entity] = asAny().mapRevisionToReferences(
                revision,
                parsedKey,
            );
            expect(entity.processingStatus).toBe(
                PromptProcessingStatus.COMPLETED,
            );
        });

        it('skips requirements whose source type cannot be resolved', () => {
            const requirements = [
                {
                    id: 'req-skip',
                    metadata: { sourceType: 'bogus' },
                    dependencies: [knowledgeDep('src/a.ts')],
                },
                {
                    id: 'req-keep',
                    metadata: { sourceType: PromptSourceType.KODY_RULE },
                    dependencies: [knowledgeDep('src/b.ts')],
                },
            ];
            const revision = { uuid: 'rev-1', requirements } as any;
            const result = asAny().mapRevisionToReferences(revision, parsedKey);
            expect(result).toHaveLength(1);
            expect(result[0].sourceType).toBe(PromptSourceType.KODY_RULE);
        });
    });
});
