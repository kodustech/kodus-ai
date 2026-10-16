import { CentralizedConfigSyncUseCase } from '../centralized-config-sync.use-case';

/**
 * Production 2026-09-28: one org's 22 rule files failed the rule schema on every
 * sync, and each sync logged "Failed to synchronize Kody rules" at error — 81
 * error events in twelve hours for YAML only the org can fix. A file the
 * repository gets wrong is a warning with the per-file reasons; an exception
 * inside the sync is still an error.
 */
describe('CentralizedConfigSyncUseCase — log level of a failed rule sync', () => {
    function makeUseCase(syncRulesResult: Record<string, unknown>) {
        const service = {
            validateCentralizedConfig: jest
                .fn()
                .mockResolvedValue({ success: true, message: 'ok' }),
            getCentralizedConfigRepository: jest
                .fn()
                .mockResolvedValue({ id: 'central', name: 'kodus' }),
            discoverConfigFiles: jest.fn().mockResolvedValue([]),
            discoverKodyRulesFiles: jest.fn().mockResolvedValue([]),
            synchronizeConfigs: jest
                .fn()
                .mockResolvedValue({ success: true, message: 'ok' }),
            synchronizeKodyRules: jest.fn().mockResolvedValue(syncRulesResult),
            removeStaleConfigs: jest.fn(),
            removeStaleKodyRules: jest.fn(),
        };
        const useCase = new CentralizedConfigSyncUseCase(service as any);
        const logger = (useCase as any).logger;
        return { useCase, logger, service };
    }

    const run = (useCase: CentralizedConfigSyncUseCase) =>
        useCase.execute({
            organizationAndTeamData: { organizationId: 'o', teamId: 't' },
        } as any);

    const failureDetails = [
        {
            file: 'app-baseline/.kody-rules/review/add-tests.yml',
            error: 'Rule file does not comply with required schema: severity: Invalid option',
        },
    ];

    it('warns, with the per-file reasons, when rule files were rejected', async () => {
        const { useCase, logger } = makeUseCase({
            success: false,
            message: 'Kody rules sync incomplete — synced 7, failed 1',
            failureDetails,
        });

        const result = await run(useCase);

        expect(result.success).toBe(false);
        expect(logger.error).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({ failureDetails }),
            }),
        );
    });

    it('still errors when the sync itself threw', async () => {
        const { useCase, logger } = makeUseCase({
            success: false,
            message: 'Error synchronizing Kody rules',
            failureDetails: [{ file: 'general', error: 'boom' }],
        });

        await run(useCase);

        expect(logger.error).toHaveBeenCalled();
    });

    it('still errors when a thrown sync sits beside rejected files', async () => {
        const { useCase, logger } = makeUseCase({
            success: false,
            message: 'Error synchronizing Kody rules',
            failureDetails: [...failureDetails, { file: 'general', error: 'boom' }],
        });

        await run(useCase);

        expect(logger.error).toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('still errors on a failure that names no file', async () => {
        const { useCase, logger } = makeUseCase({
            success: false,
            message: 'Error synchronizing Kody rules',
        });

        await run(useCase);

        expect(logger.error).toHaveBeenCalled();
    });

    it('does not run the stale-rule cleanup on a partial sync', async () => {
        const { useCase, service } = makeUseCase({
            success: false,
            message: 'Kody rules sync incomplete — synced 7, failed 1',
            failureDetails,
        });

        await run(useCase);

        expect(service.removeStaleKodyRules).not.toHaveBeenCalled();
    });
});
