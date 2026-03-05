import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { KodyRulesValidationService } from '@libs/ee/kodyRules/service/kody-rules-validation.service';
import { KodyRulesService } from '@libs/ee/kodyRules/service/kodyRules.service';
import {
    IKodyRule,
    IKodyRules,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

describe('KodyRulesService.findMemories', () => {
    const organizationAndTeamData: OrganizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const createMemoryRule = (overrides: Partial<IKodyRule>): IKodyRule => ({
        uuid: overrides.uuid || Math.random().toString(36),
        type: KodyRulesType.MEMORY,
        title: overrides.title || 'Memory title',
        rule: overrides.rule || 'Memory rule',
        status: overrides.status || KodyRulesStatus.ACTIVE,
        repositoryId: overrides.repositoryId || 'global',
        directoryId: overrides.directoryId,
        path: overrides.path,
        severity: 'medium',
        createdAt: overrides.createdAt || new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: overrides.updatedAt || new Date('2026-01-01T00:00:00.000Z'),
        inheritance: overrides.inheritance || {
            inheritable: true,
            include: [],
            exclude: [],
        },
    });

    const setup = (rules: IKodyRule[]) => {
        const repositoryMock = {
            findByOrganizationId: jest
                .fn()
                .mockResolvedValue({ rules } as unknown as IKodyRules),
        };

        const validationService = new KodyRulesValidationService({} as any);

        const service = new KodyRulesService(
            repositoryMock as any,
            { registerKodyRulesLog: jest.fn() } as any,
            {} as any,
            {} as any,
            validationService,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );

        return { service, repositoryMock };
    };

    it('applies inheritance semantics when retrieving memories', async () => {
        const globalMemory = createMemoryRule({
            uuid: 'global-memory',
            repositoryId: 'global',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
        });

        const excludedByInheritable = createMemoryRule({
            uuid: 'repo-not-inheritable',
            repositoryId: 'repo-1',
            inheritance: {
                inheritable: false,
                include: [],
                exclude: [],
            },
            createdAt: new Date('2026-01-02T00:00:00.000Z'),
        });

        const excludedByDirectory = createMemoryRule({
            uuid: 'repo-excluded-dir',
            repositoryId: 'repo-1',
            inheritance: {
                inheritable: true,
                include: [],
                exclude: ['dir-1'],
            },
            createdAt: new Date('2026-01-03T00:00:00.000Z'),
        });

        const directoryMemory = createMemoryRule({
            uuid: 'directory-memory',
            repositoryId: 'repo-1',
            directoryId: 'dir-1',
            createdAt: new Date('2026-01-04T00:00:00.000Z'),
        });

        const { service } = setup([
            globalMemory,
            excludedByInheritable,
            excludedByDirectory,
            directoryMemory,
        ]);

        const result = await service.findMemories(organizationAndTeamData, {
            repositoryId: 'repo-1',
            directoryId: 'dir-1',
        });

        expect(result.map((memory) => memory.uuid)).toEqual([
            'directory-memory',
            'global-memory',
        ]);
    });

    it('ignores directoryId filter when repositoryId is not provided', async () => {
        const globalMemory = createMemoryRule({
            uuid: 'global-memory',
            repositoryId: 'global',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
        });

        const directoryMemory = createMemoryRule({
            uuid: 'directory-memory',
            repositoryId: 'repo-1',
            directoryId: 'dir-1',
            createdAt: new Date('2026-01-03T00:00:00.000Z'),
        });

        const otherDirectoryMemory = createMemoryRule({
            uuid: 'other-directory-memory',
            repositoryId: 'repo-1',
            directoryId: 'dir-2',
            createdAt: new Date('2026-01-04T00:00:00.000Z'),
        });

        const { service } = setup([
            globalMemory,
            directoryMemory,
            otherDirectoryMemory,
        ]);

        const result = await service.findMemories(organizationAndTeamData, {
            directoryId: 'dir-1',
        });

        expect(result.map((memory) => memory.uuid)).toEqual([
            'other-directory-memory',
            'directory-memory',
            'global-memory',
        ]);
    });

    it('includes pathless memories when path filter is provided', async () => {
        const pathlessMemory = createMemoryRule({
            uuid: 'pathless-memory',
            repositoryId: 'repo-1',
            path: undefined,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
        });

        const matchingPathMemory = createMemoryRule({
            uuid: 'matching-path-memory',
            repositoryId: 'repo-1',
            path: 'src/**',
            createdAt: new Date('2026-01-02T00:00:00.000Z'),
        });

        const nonMatchingPathMemory = createMemoryRule({
            uuid: 'non-matching-path-memory',
            repositoryId: 'repo-1',
            path: 'docs/**',
            createdAt: new Date('2026-01-03T00:00:00.000Z'),
        });

        const { service } = setup([
            pathlessMemory,
            matchingPathMemory,
            nonMatchingPathMemory,
        ]);

        const result = await service.findMemories(organizationAndTeamData, {
            repositoryId: 'repo-1',
            path: 'src/components',
        });

        expect(result.map((memory) => memory.uuid)).toEqual([
            'matching-path-memory',
            'pathless-memory',
        ]);
    });

    it('filters memories by keywords and trims keyword input', async () => {
        const memoryA = createMemoryRule({
            uuid: 'memory-a',
            title: 'Use strict typing',
            rule: 'Prefer explicit return types',
            repositoryId: 'repo-1',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
        });

        const memoryB = createMemoryRule({
            uuid: 'memory-b',
            title: 'Logging',
            rule: 'Log retry attempts',
            repositoryId: 'repo-1',
            createdAt: new Date('2026-01-02T00:00:00.000Z'),
        });

        const { service } = setup([memoryA, memoryB]);

        const result = await service.findMemories(organizationAndTeamData, {
            repositoryId: 'repo-1',
            keywords: ['  strict  '],
        });

        expect(result.map((memory) => memory.uuid)).toEqual(['memory-a']);
    });

    it('clamps limit to min 1 and max 20', async () => {
        const memories = Array.from({ length: 25 }).map((_, index) =>
            createMemoryRule({
                uuid: `m-${index}`,
                repositoryId: 'repo-1',
                createdAt: new Date(
                    `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
                ),
            }),
        );

        const { service } = setup(memories);

        const limitedToOne = await service.findMemories(
            organizationAndTeamData,
            {
                repositoryId: 'repo-1',
                limit: 0,
            },
        );

        const limitedToTwenty = await service.findMemories(
            organizationAndTeamData,
            {
                repositoryId: 'repo-1',
                limit: 999,
            },
        );

        expect(limitedToOne).toHaveLength(1);
        expect(limitedToTwenty).toHaveLength(20);
    });

    it('returns most recent memories first', async () => {
        const oldMemory = createMemoryRule({
            uuid: 'old-memory',
            repositoryId: 'repo-1',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
        });
        const newMemory = createMemoryRule({
            uuid: 'new-memory',
            repositoryId: 'repo-1',
            createdAt: new Date('2026-01-03T00:00:00.000Z'),
        });

        const { service } = setup([oldMemory, newMemory]);

        const result = await service.findMemories(organizationAndTeamData, {
            repositoryId: 'repo-1',
        });

        expect(result.map((memory) => memory.uuid)).toEqual([
            'new-memory',
            'old-memory',
        ]);
    });
});
