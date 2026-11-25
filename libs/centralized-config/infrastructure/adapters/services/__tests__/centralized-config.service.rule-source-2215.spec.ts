/**
 * #2215: one team's centralized-config sync deleted the Kody Rules of the
 * organization's other teams. Rules are stored once per organization, and the
 * sync treated every centralized rule as its own. Each synced rule now
 * records the config repository (and Git connection) it came from; matching
 * and stale cleanup only touch rules from the repository being synced.
 */
import { createLogger } from '@libs/core/log/logger';
import { ParametersKey } from '@libs/core/domain/enums';
import {
    KodyRuleCentralizedStatus,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import { CentralizedConfigService } from '../centralized-config.service';

const teamB = { organizationId: 'org-1', teamId: 'team-b' };
const actor = {
    organizationId: 'org-1',
    source: 'sync' as const,
    userEmail: 'kody@kodus.io',
    userId: 'kody',
};
const configFiles = [{ path: 'kodus-config.yml' } as any];
const pathOf = (name: string) => `repo-1/.kody-rules/review/${name}.yml`;

const meta = (name: string) => ({
    centralizedDirectoryPath: 'repo-1/.kody-rules/review',
    repositoryId: 'repo-1',
    ruleType: KodyRulesType.STANDARD,
    ruleFilePath: pathOf(name),
    path: pathOf(name),
});

const rule = (name: string, source?: Record<string, unknown>) => ({
    uuid: `uuid-${name}`,
    title: name,
    rule: `rule text of ${name}`,
    severity: 'high',
    status: KodyRulesStatus.ACTIVE,
    repositoryId: 'repo-1',
    type: KodyRulesType.STANDARD,
    centralizedConfig: {
        path: pathOf(name),
        status: KodyRuleCentralizedStatus.SYNCED,
        ...source,
    },
});

const fromA = { sourceRepositoryId: 'cfg-a' };
const fromB = { sourceRepositoryId: 'cfg-b' };

const centralized = (id: string) => ({
    configValue: { enabled: true, repository: { id, name: id } },
});

function build(opts: {
    rules: any[];
    sources?: Array<ReturnType<typeof centralized>>;
    centralizedValue?: Record<string, unknown>;
}) {
    const createOrUpdate = { execute: jest.fn().mockResolvedValue({}) };
    const deleteRule = { execute: jest.fn().mockResolvedValue(true) };
    const parametersService = {
        findByKey: jest.fn(async (key: string) =>
            key === ParametersKey.CENTRALIZED_CONFIG
                ? {
                      configValue: opts.centralizedValue ?? {
                          enabled: true,
                          repository: { id: 'cfg-b', name: 'cfg-b' },
                      },
                  }
                : undefined,
        ),
        findActiveByKeyInOrganization: jest.fn(
            async () =>
                opts.sources ?? [centralized('cfg-a'), centralized('cfg-b')],
        ),
    };
    const service = new CentralizedConfigService(
        parametersService as any,
        {
            findIntegrationConfigFormatted: jest
                .fn()
                .mockResolvedValue([{ id: 'repo-1', name: 'repo-1' }]),
        } as any,
        {} as any,
        { execute: jest.fn() } as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        createOrUpdate as any,
        deleteRule as any,
        {
            findByOrganizationId: jest.fn().mockResolvedValue({
                rules: opts.rules,
                toJson: () => ({ rules: opts.rules }),
            }),
        } as any,
        { lastDetectionFailed: jest.fn().mockResolvedValue(false) } as any,
    );
    jest.spyOn(service, 'fetchKodyRuleFile').mockImplementation(
        async ({ filePath }: { filePath: string }) => ({
            title: filePath,
            rule: `rule text of ${filePath}`,
            severity: 'high',
        }),
    );
    return { service, createOrUpdate, deleteRule };
}

describe('#2215 centralized rules belong to the config repository they came from', () => {
    beforeAll(() => {
        for (const level of ['log', 'warn', 'error'] as const) {
            jest.spyOn(createLogger(''), level).mockImplementation(() => {});
        }
    });

    describe('removeStaleKodyRules', () => {
        it("does not delete a rule another team's config repository synced", async () => {
            const { service, deleteRule } = build({
                rules: [rule('of-a', fromA), rule('of-b', fromB)],
            });

            await service.removeStaleKodyRules({
                organizationAndTeamData: teamB,
                ruleFiles: [meta('of-b')],
                configFiles,
                actor,
            });

            expect(deleteRule.execute).not.toHaveBeenCalled();
        });

        it('deletes its own rule whose file is gone', async () => {
            const { service, deleteRule } = build({
                rules: [rule('of-a', fromA), rule('gone', fromB)],
            });

            await service.removeStaleKodyRules({
                organizationAndTeamData: teamB,
                ruleFiles: [],
                configFiles,
                actor,
            });

            expect(deleteRule.execute).toHaveBeenCalledTimes(1);
            expect(deleteRule.execute).toHaveBeenCalledWith('uuid-gone', actor);
        });

        it('leaves a rule synced before sources were recorded while the organization has several config repositories', async () => {
            const { service, deleteRule } = build({ rules: [rule('legacy')] });

            await service.removeStaleKodyRules({
                organizationAndTeamData: teamB,
                ruleFiles: [],
                configFiles,
                actor,
            });

            expect(deleteRule.execute).not.toHaveBeenCalled();
        });

        it('still deletes such a rule when the organization has a single config repository', async () => {
            const { service, deleteRule } = build({
                rules: [rule('legacy')],
                sources: [centralized('cfg-b')],
            });

            await service.removeStaleKodyRules({
                organizationAndTeamData: teamB,
                ruleFiles: [],
                configFiles,
                actor,
            });

            expect(deleteRule.execute).toHaveBeenCalledWith(
                'uuid-legacy',
                actor,
            );
        });

        it('counts the config repositories of every Git connection', async () => {
            const { service, deleteRule } = build({
                rules: [rule('legacy')],
                sources: [
                    {
                        configValue: {
                            enabled: true,
                            repository: { id: 'cfg-b', name: 'cfg-b' },
                            connections: {
                                'gl-c': {
                                    enabled: true,
                                    repository: { id: 'cfg-c', name: 'cfg-c' },
                                },
                            },
                        } as any,
                    },
                ],
            });

            await service.removeStaleKodyRules({
                organizationAndTeamData: teamB,
                ruleFiles: [],
                configFiles,
                actor,
            });

            expect(deleteRule.execute).not.toHaveBeenCalled();
        });
    });

    describe('synchronizeKodyRules', () => {
        it('records the config repository and connection on the rules it syncs', async () => {
            const { service, createOrUpdate } = build({
                rules: [],
                centralizedValue: {
                    enabled: true,
                    repository: { id: 'cfg-b', name: 'cfg-b' },
                    connectionScoped: true,
                },
            });

            await service.synchronizeKodyRules({
                organizationAndTeamData: { ...teamB, integrationId: 'gl-b' },
                ruleFiles: [meta('new')],
                actor,
            });

            expect(
                createOrUpdate.execute.mock.calls[0][0].centralizedConfig,
            ).toEqual({
                path: pathOf('new'),
                status: KodyRuleCentralizedStatus.SYNCED,
                sourceRepositoryId: 'cfg-b',
                sourceConnectionId: 'gl-b',
                connectionScoped: true,
            });
        });

        it("creates its own rule instead of updating another repository's rule at the same path", async () => {
            const { service, createOrUpdate } = build({
                rules: [rule('shared', fromA)],
            });

            await service.synchronizeKodyRules({
                organizationAndTeamData: teamB,
                ruleFiles: [meta('shared')],
                actor,
            });

            expect(
                createOrUpdate.execute.mock.calls[0][0].uuid,
            ).toBeUndefined();
        });

        it('adopts a rule synced before sources were recorded, at the same path', async () => {
            const { service, createOrUpdate } = build({
                rules: [rule('legacy')],
            });

            await service.synchronizeKodyRules({
                organizationAndTeamData: teamB,
                ruleFiles: [meta('legacy')],
                actor,
            });

            expect(createOrUpdate.execute.mock.calls[0][0]).toMatchObject({
                uuid: 'uuid-legacy',
                centralizedConfig: { sourceRepositoryId: 'cfg-b' },
            });
        });
    });
});
