jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }),
}));

import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';

import { SendKodyRulesAutoPauseDigestUseCase } from './send-kody-rules-auto-pause-digest.use-case';

const NOW = new Date('2026-10-26T09:00:00.000Z');
const ORG = 'org-1';

const pause = (over: Record<string, unknown> = {}) => ({
    state: 'ignored',
    pausedAt: new Date('2026-10-21T06:00:00.000Z'),
    windowStart: new Date('2026-09-21T06:00:00.000Z'),
    windowEnd: new Date('2026-10-21T06:00:00.000Z'),
    triggers: 14,
    implemented: 2,
    rate: 0.14,
    thumbsUp: 0,
    thumbsDown: 0,
    digestedAt: null,
    ...over,
});

const rule = (uuid: string, over: Record<string, unknown> = {}) => ({
    uuid,
    title: `Rule ${uuid}`,
    repositoryId: 'repo-1',
    status: KodyRulesStatus.PAUSED,
    ...over,
});

describe('SendKodyRulesAutoPauseDigestUseCase', () => {
    let kodyRulesService: {
        findByOrganizationId: jest.Mock;
        findOrganizationIdsWithRules: jest.Mock;
        markAutoPausesDigested: jest.Mock;
    };
    let reviewAnalytics: { getRepositoryNames: jest.Mock };
    let notificationService: { emit: jest.Mock };
    let useCase: SendKodyRulesAutoPauseDigestUseCase;

    const givenRules = (rules: unknown[]) =>
        kodyRulesService.findByOrganizationId.mockResolvedValue({
            uuid: 'doc-1',
            rules,
        });

    const emittedRules = () =>
        notificationService.emit.mock.calls[0][0].payload.rules;

    beforeEach(() => {
        kodyRulesService = {
            findByOrganizationId: jest.fn(),
            findOrganizationIdsWithRules: jest.fn().mockResolvedValue([ORG]),
            markAutoPausesDigested: jest.fn().mockResolvedValue(true),
        };
        reviewAnalytics = {
            getRepositoryNames: jest
                .fn()
                .mockResolvedValue(new Map([['repo-1', 'acme/api']])),
        };
        notificationService = { emit: jest.fn().mockResolvedValue(undefined) };
        useCase = new SendKodyRulesAutoPauseDigestUseCase(
            kodyRulesService as any,
            reviewAnalytics as any,
            notificationService as any,
        );
    });

    it('emails the rules paused since the last digest, then marks them sent', async () => {
        const autoPause = pause();
        givenRules([
            rule('new-1', { autoPause }),
            rule('old-1', {
                autoPause: pause({
                    digestedAt: new Date('2026-10-19T09:00:00Z'),
                }),
            }),
            rule('manual-1'),
        ]);

        const result = await useCase.executeForOrganization(ORG, NOW);

        expect(result.sent).toBe(1);
        expect(notificationService.emit).toHaveBeenCalledWith({
            event: NotificationEvent.KODY_RULES_AUTO_PAUSE_DIGEST,
            organizationId: ORG,
            payload: {
                periodStart: '2026-10-19T09:00:00.000Z',
                periodEnd: NOW.toISOString(),
                rules: [
                    expect.objectContaining({
                        ruleId: 'new-1',
                        title: 'Rule new-1',
                        repositoryName: 'acme/api',
                        state: 'ignored',
                        resumed: false,
                    }),
                ],
            },
        });
        expect(kodyRulesService.markAutoPausesDigested).toHaveBeenCalledTimes(
            1,
        );
        expect(kodyRulesService.markAutoPausesDigested).toHaveBeenCalledWith(
            ORG,
            'new-1',
            [autoPause.pausedAt],
            NOW,
        );
    });

    it('sends no email when nothing new was paused', async () => {
        givenRules([
            rule('old-1', { autoPause: pause({ digestedAt: new Date() }) }),
        ]);

        const result = await useCase.executeForOrganization(ORG, NOW);

        expect(result.sent).toBe(0);
        expect(notificationService.emit).not.toHaveBeenCalled();
        expect(kodyRulesService.markAutoPausesDigested).not.toHaveBeenCalled();
    });

    it('still lists a rule resumed before the digest, marked as resumed', async () => {
        const lastAutoPause = pause();
        givenRules([
            rule('resumed-1', {
                status: KodyRulesStatus.ACTIVE,
                autoPause: null,
                lastAutoPause,
            }),
        ]);

        await useCase.executeForOrganization(ORG, NOW);

        expect(emittedRules()).toEqual([
            expect.objectContaining({ ruleId: 'resumed-1', resumed: true }),
        ]);
        expect(kodyRulesService.markAutoPausesDigested).toHaveBeenCalledWith(
            ORG,
            'resumed-1',
            [lastAutoPause.pausedAt],
            NOW,
        );
    });

    it('lists a rule paused again before the digest once, by its latest pause', async () => {
        const first = pause({ pausedAt: new Date('2026-10-20T06:00:00Z') });
        const second = pause({
            state: 'noisy',
            pausedAt: new Date('2026-10-24T06:00:00Z'),
        });
        givenRules([
            rule('again-1', { autoPause: second, lastAutoPause: first }),
        ]);

        await useCase.executeForOrganization(ORG, NOW);

        expect(emittedRules()).toEqual([
            expect.objectContaining({
                ruleId: 'again-1',
                state: 'noisy',
                resumed: false,
            }),
        ]);
        expect(kodyRulesService.markAutoPausesDigested).toHaveBeenCalledWith(
            ORG,
            'again-1',
            [second.pausedAt, first.pausedAt],
            NOW,
        );
    });

    it('leaves deleted rules out', async () => {
        givenRules([
            rule('gone-1', {
                status: KodyRulesStatus.DELETED,
                autoPause: pause(),
            }),
        ]);

        const result = await useCase.executeForOrganization(ORG, NOW);

        expect(result.sent).toBe(0);
        expect(notificationService.emit).not.toHaveBeenCalled();
    });

    it('marks nothing when the email could not be queued, so next week retries', async () => {
        givenRules([rule('new-1', { autoPause: pause() })]);
        notificationService.emit.mockRejectedValue(new Error('outbox down'));

        await expect(useCase.executeForOrganization(ORG, NOW)).rejects.toThrow(
            'outbox down',
        );
        expect(kodyRulesService.markAutoPausesDigested).not.toHaveBeenCalled();
    });

    it('runs every organization and survives one failing', async () => {
        kodyRulesService.findOrganizationIdsWithRules.mockResolvedValue([
            'org-broken',
            ORG,
        ]);
        kodyRulesService.findByOrganizationId.mockImplementation(async (id) => {
            if (id === 'org-broken') throw new Error('mongo down');
            return {
                uuid: 'doc-1',
                rules: [rule('new-1', { autoPause: pause() })],
            };
        });

        const result = await useCase.execute(NOW);

        expect(result).toEqual({
            organizations: 2,
            emailed: 1,
            rules: 1,
            failedOrganizations: 1,
        });
    });
});
