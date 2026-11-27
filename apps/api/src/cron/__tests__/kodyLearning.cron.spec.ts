jest.mock('@libs/core/log/logger', () => {
    const spy = {
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    };
    return { createLogger: () => spy, __loggerSpy: spy };
});

import { KodyLearningCronProvider } from '../kodyLearning.cron';
import { KodyLearningStatus } from '@libs/organization/domain/parameters/types/configValue.type';
import { MAX_STUCK_RETRIES } from '../kody-learning-staleness';

const loggerSpy = (
    jest.requireMock('@libs/core/log/logger') as {
        __loggerSpy: { error: jest.Mock };
    }
).__loggerSpy;

describe('KodyLearningCronProvider — distributed lock', () => {
    const build = (lockAcquired: boolean) => {
        const teamService = {
            findTeamsWithIntegrations: jest.fn().mockResolvedValue([]),
        };
        const parametersService = { findByKey: jest.fn() };
        const generateKodyRulesUseCase = { execute: jest.fn() };
        const generateInitialKodyRulesUseCase = {
            hasPastReviewRulesForRepos: jest
                .fn()
                .mockResolvedValue(new Set<string>()),
        };
        const lock = { release: jest.fn().mockResolvedValue(undefined) };
        const distributedLockService = {
            acquire: jest.fn().mockResolvedValue(lockAcquired ? lock : null),
        };

        const cron = new KodyLearningCronProvider(
            teamService as any,
            parametersService as any,
            generateKodyRulesUseCase as any,
            generateInitialKodyRulesUseCase as any,
            distributedLockService as any,
        );

        return { cron, teamService, distributedLockService, lock };
    };

    it('skips the run when the lock is already held by another instance', async () => {
        const { cron, teamService, distributedLockService } = build(false);

        await cron.handleCron();

        expect(distributedLockService.acquire).toHaveBeenCalledTimes(1);
        expect(teamService.findTeamsWithIntegrations).not.toHaveBeenCalled();
    });

    it('runs the sweep and releases the lock when it is acquired', async () => {
        const { cron, teamService, lock } = build(true);

        await cron.handleCron();

        expect(teamService.findTeamsWithIntegrations).toHaveBeenCalledTimes(1);
        expect(lock.release).toHaveBeenCalledTimes(1);
    });
});

describe('KodyLearningCronProvider — organization on error logs', () => {
    const team = {
        uuid: 'team-1',
        organization: { uuid: 'org-1' },
    };

    const build = (platformConfigs: unknown) => {
        const teamService = {
            findTeamsWithIntegrations: jest.fn().mockResolvedValue([team]),
        };
        const parametersService = {
            findByKey: jest.fn().mockResolvedValue(platformConfigs),
        };
        const lock = { release: jest.fn().mockResolvedValue(undefined) };
        const distributedLockService = {
            acquire: jest.fn().mockResolvedValue(lock),
        };
        const cron = new KodyLearningCronProvider(
            teamService as any,
            parametersService as any,
            { execute: jest.fn() } as any,
            { hasPastReviewRulesForRepos: jest.fn() } as any,
            distributedLockService as any,
        );
        return { cron, lock };
    };

    beforeEach(() => {
        loggerSpy.error.mockClear();
    });

    it('logs the organization when platform configs are missing', async () => {
        const { cron } = build(null);

        await cron.handleCron();

        expect(loggerSpy.error).toHaveBeenCalledWith(
            expect.objectContaining({
                message: 'Platform configs not found',
                metadata: expect.objectContaining({
                    organizationId: 'org-1',
                    teamId: 'team-1',
                }),
            }),
        );
    });

    it('logs the organization when a stuck team has exhausted retries', async () => {
        const { cron } = build({
            updatedAt: new Date(0),
            configValue: {
                kodyLearningStatus: KodyLearningStatus.GENERATING_RULES,
                kodyLearningStuckRetries: MAX_STUCK_RETRIES,
            },
        });

        await cron.handleCron();

        expect(loggerSpy.error).toHaveBeenCalledWith(
            expect.objectContaining({
                message:
                    'Kody learning stuck and exhausted retries — giving up',
                metadata: expect.objectContaining({
                    organizationId: 'org-1',
                    teamId: 'team-1',
                }),
            }),
        );
    });
});
