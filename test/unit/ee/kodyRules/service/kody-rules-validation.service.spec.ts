import { KodyRulesValidationService } from '@libs/ee/kodyRules/service/kody-rules-validation.service';
import {
    IKodyRule,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

const shouldLimitResourcesMock = jest.fn();

jest.mock('@libs/ee/configs/environment', () => ({
    environment: {
        API_CLOUD_MODE: true,
    },
}));

const createRule = (
    overrides: Partial<IKodyRule> = {},
): Partial<IKodyRule> => ({
    uuid: overrides.uuid || Math.random().toString(36).slice(2),
    title: overrides.title || 'Title',
    rule: overrides.rule || 'Rule',
    type: overrides.type || KodyRulesType.STANDARD,
    status: overrides.status || KodyRulesStatus.ACTIVE,
    repositoryId: overrides.repositoryId || 'repo-1',
    directoryId: overrides.directoryId,
    path: overrides.path,
    inheritance: overrides.inheritance || {
        inheritable: true,
        include: [],
        exclude: [],
    },
    createdAt: overrides.createdAt || new Date('2026-01-01T00:00:00.000Z'),
});

describe('KodyRulesValidationService', () => {
    let service: KodyRulesValidationService;

    beforeEach(() => {
        shouldLimitResourcesMock.mockReset();
        service = new KodyRulesValidationService({
            shouldLimitResources: shouldLimitResourcesMock,
        } as any);
    });

    describe('validateRulesLimit', () => {
        it('returns true when resource limits are not enforced', async () => {
            shouldLimitResourcesMock.mockResolvedValue(false);

            const result = await service.validateRulesLimit(
                { organizationId: 'org-1' } as any,
                999,
            );

            expect(result).toBe(true);
        });

        it('returns false when enforced limit is exceeded', async () => {
            shouldLimitResourcesMock.mockResolvedValue(true);

            const result = await service.validateRulesLimit(
                { organizationId: 'org-1' } as any,
                11,
            );

            expect(result).toBe(false);
        });
    });

    describe('filterKodyRules', () => {
        it('returns standard and memory rules separated in createdAt order', () => {
            const rules = [
                createRule({
                    uuid: 'global-standard',
                    repositoryId: 'global',
                    type: KodyRulesType.STANDARD,
                    rule: 'global standard rule',
                    createdAt: new Date('2026-01-03T00:00:00.000Z'),
                }),
                createRule({
                    uuid: 'repo-memory',
                    repositoryId: 'repo-1',
                    type: KodyRulesType.MEMORY,
                    rule: 'repo memory rule',
                    createdAt: new Date('2026-01-02T00:00:00.000Z'),
                }),
                createRule({
                    uuid: 'repo-standard',
                    repositoryId: 'repo-1',
                    type: KodyRulesType.STANDARD,
                    rule: 'repo standard rule',
                    createdAt: new Date('2026-01-01T00:00:00.000Z'),
                }),
                createRule({
                    uuid: 'inactive',
                    status: KodyRulesStatus.PENDING,
                }),
            ];

            const result = service.filterKodyRules(rules, 'repo-1');

            expect(result.standardRules.map((rule) => rule.uuid)).toEqual([
                'repo-standard',
                'global-standard',
            ]);
            expect(result.memoryRules.map((rule) => rule.uuid)).toEqual([
                'repo-memory',
            ]);
        });

        it('removes duplicates by rule text', () => {
            const rules = [
                createRule({
                    uuid: 'first',
                    rule: 'duplicated',
                    repositoryId: 'repo-1',
                }),
                createRule({
                    uuid: 'second',
                    rule: 'duplicated',
                    repositoryId: 'global',
                }),
            ];

            const result = service.filterKodyRules(rules, 'repo-1');

            expect(result.standardRules).toHaveLength(1);
            expect(result.standardRules[0].uuid).toBe('first');
        });
    });

    describe('getMemoryRulesForContext', () => {
        it('returns only active memory rules matching repository and path context', () => {
            const rules = [
                createRule({
                    uuid: 'global-memory',
                    type: KodyRulesType.MEMORY,
                    repositoryId: 'global',
                    path: 'src/**',
                }),
                createRule({
                    uuid: 'repo-memory',
                    type: KodyRulesType.MEMORY,
                    repositoryId: 'repo-1',
                    path: 'src/components/**',
                }),
                createRule({
                    uuid: 'repo-standard',
                    type: KodyRulesType.STANDARD,
                    repositoryId: 'repo-1',
                }),
                createRule({
                    uuid: 'inactive-memory',
                    type: KodyRulesType.MEMORY,
                    repositoryId: 'repo-1',
                    status: KodyRulesStatus.PENDING,
                }),
            ];

            const result = service.getMemoryRulesForContext(
                'src/components',
                rules,
                {
                    repositoryId: 'repo-1',
                },
            );

            expect(result.map((rule) => rule.uuid)).toEqual([
                'global-memory',
                'repo-memory',
            ]);
        });

        it('ignores directory filter when repository is not provided', () => {
            const rules = [
                createRule({
                    uuid: 'dir-1-memory',
                    type: KodyRulesType.MEMORY,
                    repositoryId: 'repo-1',
                    directoryId: 'dir-1',
                }),
                createRule({
                    uuid: 'dir-2-memory',
                    type: KodyRulesType.MEMORY,
                    repositoryId: 'repo-1',
                    directoryId: 'dir-2',
                }),
            ];

            const result = service.getMemoryRulesForContext(null, rules, {
                directoryId: 'dir-1',
            });

            expect(result.map((rule) => rule.uuid)).toEqual([
                'dir-1-memory',
                'dir-2-memory',
            ]);
        });

        it('respects inheritance include and exclude in repository context', () => {
            const rules = [
                createRule({
                    uuid: 'excluded',
                    type: KodyRulesType.MEMORY,
                    repositoryId: 'global',
                    inheritance: {
                        inheritable: true,
                        include: [],
                        exclude: ['repo-1'],
                    },
                }),
                createRule({
                    uuid: 'included',
                    type: KodyRulesType.MEMORY,
                    repositoryId: 'global',
                    inheritance: {
                        inheritable: true,
                        include: ['repo-1'],
                        exclude: [],
                    },
                }),
            ];

            const result = service.getMemoryRulesForContext(null, rules, {
                repositoryId: 'repo-1',
            });

            expect(result.map((rule) => rule.uuid)).toEqual(['included']);
        });
    });
});
