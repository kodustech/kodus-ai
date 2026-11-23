/**
 * A centralized-config sync over a repository nobody changed must not write
 * Kody Rules. In production every PR event ran the sync, and each run deleted
 * again the rules it had already deleted and rewrote every unchanged rule.
 * The cost against a real MongoDB is measured in
 * centralized-config.kody-rules-sync.integration.spec.ts; these pin the
 * decisions without one.
 */
import { createLogger } from '@libs/core/log/logger';
import {
    KodyRuleCentralizedStatus,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import { CentralizedConfigService } from '../centralized-config.service';

const organizationAndTeamData = { organizationId: 'org-1', teamId: 'team-1' };
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

// A rule exactly as a previous sync of `name` stored it.
const storedRule = (name: string, overrides: Record<string, unknown> = {}) => ({
    uuid: `uuid-${name}`,
    title: name,
    rule: `rule text of ${name}`,
    severity: 'high',
    examples: [],
    path: '**/*',
    scope: 'file',
    inheritance: { inheritable: true, include: [], exclude: [] },
    type: KodyRulesType.STANDARD,
    status: KodyRulesStatus.ACTIVE,
    repositoryId: 'repo-1',
    centralizedConfig: {
        path: pathOf(name),
        status: KodyRuleCentralizedStatus.SYNCED,
    },
    origin: 'repo_file_sync',
    ...overrides,
});

function build(rules: any[], files: Record<string, any>) {
    const createOrUpdate = { execute: jest.fn().mockResolvedValue({}) };
    const detection = {
        lastDetectionFailed: jest.fn().mockResolvedValue(false),
    };
    const deleteRule = { execute: jest.fn().mockResolvedValue(true) };
    const kodyRulesService = {
        findByOrganizationId: jest.fn().mockResolvedValue({
            rules,
            toJson: () => ({ rules }),
        }),
    };
    const service = new CentralizedConfigService(
        {} as any,
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
        kodyRulesService as any,
        detection as any,
    );
    jest.spyOn(service, 'getCentralizedConfigRepository').mockResolvedValue({
        id: 'config-repo',
        name: 'config-repo',
    } as any);
    jest.spyOn(service, 'fetchKodyRuleFile').mockImplementation(
        async ({ filePath }: { filePath: string }) => files[filePath] ?? null,
    );
    return { service, createOrUpdate, deleteRule, detection };
}

const fileOf = (name: string, overrides: Record<string, unknown> = {}) => ({
    title: name,
    rule: `rule text of ${name}`,
    severity: 'high',
    ...overrides,
});

describe('CentralizedConfigService — a sync over an unchanged repository', () => {
    beforeAll(() => {
        for (const level of ['log', 'warn', 'error'] as const) {
            jest.spyOn(createLogger(''), level).mockImplementation(() => {});
        }
    });

    describe('removeStaleKodyRules', () => {
        it('does not delete again a rule it already deleted', async () => {
            const { service, deleteRule } = build(
                [
                    storedRule('kept'),
                    storedRule('gone', { status: KodyRulesStatus.DELETED }),
                ],
                {},
            );

            const result = await service.removeStaleKodyRules({
                organizationAndTeamData,
                ruleFiles: [meta('kept')],
                configFiles,
                actor,
            });

            expect(deleteRule.execute).not.toHaveBeenCalled();
            expect(result.removedRuleCount).toBe(0);
        });

        it('still deletes an active rule whose file is gone', async () => {
            const { service, deleteRule } = build(
                [storedRule('kept'), storedRule('removed-now')],
                {},
            );

            await service.removeStaleKodyRules({
                organizationAndTeamData,
                ruleFiles: [meta('kept')],
                configFiles,
                actor,
            });

            expect(deleteRule.execute).toHaveBeenCalledTimes(1);
            expect(deleteRule.execute).toHaveBeenCalledWith(
                'uuid-removed-now',
                actor,
            );
        });
    });

    describe('synchronizeKodyRules', () => {
        it('does not write a rule whose file did not change', async () => {
            const { service, createOrUpdate, detection } = build(
                [storedRule('same')],
                {
                    [pathOf('same')]: fileOf('same'),
                },
            );

            const result = await service.synchronizeKodyRules({
                organizationAndTeamData,
                ruleFiles: [meta('same')],
                actor,
            });

            expect(createOrUpdate.execute).not.toHaveBeenCalled();
            expect(result).toMatchObject({ success: true, syncedRuleCount: 1 });
        });

        // The write is what re-runs reference detection, so a rule whose last
        // detection failed keeps being written until one succeeds.
        it.each([
            ['failed', () => Promise.resolve(true), 1],
            ['could not be read', () => Promise.reject(new Error('down')), 1],
            ['succeeded', () => Promise.resolve(false), 0],
        ])(
            'writes an unchanged rule with references when its last detection %s',
            async (_label, answer, writes) => {
                const { service, createOrUpdate, detection } = build(
                    [storedRule('refs', { contextReferenceId: 'ref-1' })],
                    { [pathOf('refs')]: fileOf('refs') },
                );
                detection.lastDetectionFailed.mockImplementation(answer);

                await service.synchronizeKodyRules({
                    organizationAndTeamData,
                    ruleFiles: [meta('refs')],
                    actor,
                });

                expect(detection.lastDetectionFailed).toHaveBeenCalledWith(
                    'kodyRule',
                    'uuid-refs',
                );
                expect(createOrUpdate.execute).toHaveBeenCalledTimes(writes);
            },
        );

        // A first detection that failed leaves no reference id on the rule,
        // so the rule is asked whatever its pointer holds.
        it('writes an unchanged rule without a reference id whose first detection failed', async () => {
            const { service, createOrUpdate, detection } = build(
                [storedRule('first', { contextReferenceId: null })],
                { [pathOf('first')]: fileOf('first') },
            );
            detection.lastDetectionFailed.mockResolvedValue(true);

            await service.synchronizeKodyRules({
                organizationAndTeamData,
                ruleFiles: [meta('first')],
                actor,
            });

            expect(detection.lastDetectionFailed).toHaveBeenCalledWith(
                'kodyRule',
                'uuid-first',
            );
            expect(createOrUpdate.execute).toHaveBeenCalledTimes(1);
        });

        it('writes a rule whose file changed', async () => {
            const { service, createOrUpdate, detection } = build(
                [storedRule('edited')],
                {
                    [pathOf('edited')]: fileOf('edited', { rule: 'new text' }),
                },
            );

            await service.synchronizeKodyRules({
                organizationAndTeamData,
                ruleFiles: [meta('edited')],
                actor,
            });

            expect(createOrUpdate.execute).toHaveBeenCalledTimes(1);
            expect(createOrUpdate.execute.mock.calls[0][0]).toMatchObject({
                uuid: 'uuid-edited',
                rule: 'new text',
            });
        });

        it('brings back a deleted rule whose file returned', async () => {
            const { service, createOrUpdate, detection } = build(
                [storedRule('back', { status: KodyRulesStatus.DELETED })],
                { [pathOf('back')]: fileOf('back') },
            );

            await service.synchronizeKodyRules({
                organizationAndTeamData,
                ruleFiles: [meta('back')],
                actor,
            });

            expect(createOrUpdate.execute).toHaveBeenCalledTimes(1);
            expect(createOrUpdate.execute.mock.calls[0][0]).toMatchObject({
                uuid: 'uuid-back',
                status: KodyRulesStatus.ACTIVE,
            });
        });

        it('writes a rule the plan limit paused, so a free slot can lift the lock', async () => {
            const { service, createOrUpdate, detection } = build(
                [
                    storedRule('locked', {
                        status: KodyRulesStatus.PAUSED,
                        lockedByPlan: true,
                    }),
                ],
                { [pathOf('locked')]: fileOf('locked') },
            );

            await service.synchronizeKodyRules({
                organizationAndTeamData,
                ruleFiles: [meta('locked')],
                actor,
            });

            expect(createOrUpdate.execute).toHaveBeenCalledTimes(1);
            expect(createOrUpdate.execute.mock.calls[0][0]).toMatchObject({
                uuid: 'uuid-locked',
                status: KodyRulesStatus.ACTIVE,
            });
        });

        it('creates a rule for a new file', async () => {
            const { service, createOrUpdate, detection } = build([], {
                [pathOf('new')]: fileOf('new'),
            });

            await service.synchronizeKodyRules({
                organizationAndTeamData,
                ruleFiles: [meta('new')],
                actor,
            });

            expect(createOrUpdate.execute).toHaveBeenCalledTimes(1);
            expect(
                createOrUpdate.execute.mock.calls[0][0].uuid,
            ).toBeUndefined();
        });
    });
});
