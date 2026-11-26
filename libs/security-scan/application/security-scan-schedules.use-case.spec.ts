import {
    BadRequestException,
    ConflictException,
    HttpException,
    HttpStatus,
    ServiceUnavailableException,
} from '@nestjs/common';

import { SecurityScanSchedulesUseCase } from './security-scan-schedules.use-case';
import { DEEP_SCAN_NOT_ENABLED_MESSAGE } from './deep-scan.gate';

const repositoryKey = { platform: 'GITHUB', host: 'github.com', id: 'repo-1' };

const schedule = (over: Record<string, unknown> = {}) => ({
    uuid: 'sch-1',
    organizationId: 'org-1',
    teamId: 'team-1',
    repository: repositoryKey,
    cadence: 'daily' as const,
    budget: { maxUsd: 5 },
    mode: 'incremental' as const,
    enabled: true,
    nextRunAt: '2026-11-24T03:00:00.000Z',
    ...over,
});

function setup() {
    const schedules = {
        save: jest.fn(async (_org: string, _key: unknown, s: any) => ({
            uuid: 'sch-1',
            ...s,
        })),
        find: jest.fn(),
        list: jest.fn(async () => [
            schedule(),
            schedule({
                uuid: 'sch-2',
                repository: { ...repositoryKey, id: 'repo-2' },
            }),
        ]),
        remove: jest.fn(async () => true),
        setEnabled: jest.fn(
            async (
                _org: string,
                _key: unknown,
                enabled: boolean,
                next?: Date,
            ) =>
                schedule({
                    enabled,
                    ...(next ? { nextRunAt: next.toISOString() } : {}),
                }),
        ),
        findDue: jest.fn(async () => [schedule()]),
        claim: jest.fn(async () => true),
        recordRun: jest.fn(async () => undefined),
        recordError: jest.fn(async () => undefined),
    };
    const start = {
        repositoryKeyOf: jest.fn(async () => repositoryKey),
        scanModelFor: jest.fn(async () => ({ model: {}, rates: {} })),
        execute: jest.fn(async () => ({ uuid: 'scan-9' })),
    };
    const gate = { isEnabledFor: jest.fn(async () => true) };
    // The visible repositories, as the scans listing resolves them.
    const scans = {
        repositoryScope: jest.fn(async (_org: string, ids?: string[]) =>
            ids === undefined
                ? undefined
                : ids.map((id) => ({ ...repositoryKey, id })),
        ),
    };
    const useCase = new SecurityScanSchedulesUseCase(
        schedules as any,
        start as any,
        gate as any,
        scans as any,
    );
    return { useCase, schedules, start, gate, scans };
}

const now = new Date('2026-11-24T03:01:00Z');

describe('SecurityScanSchedulesUseCase', () => {
    it('starts a due scan as the schedule says, after claiming it', async () => {
        const { useCase, schedules, start } = setup();

        expect(await useCase.runDue(now)).toBe(1);

        expect(schedules.claim).toHaveBeenCalledWith(
            'sch-1',
            '2026-11-24T03:00:00.000Z',
            new Date('2026-11-25T03:00:00.000Z'),
        );
        expect(start.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                repositoryId: 'repo-1',
                budget: { maxUsd: 5 },
                mode: 'incremental',
                scheduleId: 'sch-1',
            }),
        );
        expect(schedules.recordRun).toHaveBeenCalledWith('sch-1', {
            lastRunAt: now.toISOString(),
            lastScanId: 'scan-9',
        });
    });

    it("counts a weekly schedule's next run from the run it starts, also the first one", async () => {
        const { useCase, schedules } = setup();
        schedules.findDue.mockResolvedValue([schedule({ cadence: 'weekly' })]);

        await useCase.runDue(now);

        expect(schedules.claim).toHaveBeenCalledWith(
            'sch-1',
            '2026-11-24T03:00:00.000Z',
            new Date('2026-12-01T03:00:00.000Z'),
        );
    });

    it('starts nothing another instance claimed first', async () => {
        const { useCase, schedules, start } = setup();
        schedules.claim.mockResolvedValue(false);

        expect(await useCase.runDue(now)).toBe(0);
        expect(start.execute).not.toHaveBeenCalled();
    });

    it('tries again in 30 minutes when there is no room, instead of losing its turn', async () => {
        for (const [busy, reason] of [
            [
                new ConflictException(
                    'A security scan of this repository is already running.',
                ),
                'This repository is already being scanned.',
            ],
            [
                new HttpException(
                    'This organization already has 3 deep scans queued or running.',
                    HttpStatus.TOO_MANY_REQUESTS,
                ),
                "The organization's running deep scans are at their limit.",
            ],
            [
                new ServiceUnavailableException(
                    'The deep scan worker is not taking jobs right now. Try again in a moment.',
                ),
                'The deep scan workers are not taking scans right now.',
            ],
        ]) {
            const { useCase, schedules, start } = setup();
            start.execute.mockRejectedValue(busy);

            expect(await useCase.runDue(now)).toBe(0);

            // Claimed to tomorrow, then handed back to now + 30 minutes,
            // with the reason in our words, not the exception's.
            expect(schedules.claim).toHaveBeenLastCalledWith(
                'sch-1',
                '2026-11-25T03:00:00.000Z',
                new Date('2026-11-24T03:31:00.000Z'),
            );
            expect(schedules.recordError).toHaveBeenCalledWith(
                'sch-1',
                `${reason} It tries again at 03:31 UTC.`,
            );
            expect(schedules.recordRun).not.toHaveBeenCalled();
        }
    });

    it('says why a due scan did not start, and waits for its next time', async () => {
        const { useCase, schedules, start } = setup();
        start.execute.mockRejectedValue(
            new BadRequestException(
                'The model picked for this scan is not in your AI providers any more.',
            ),
        );

        expect(await useCase.runDue(now)).toBe(0);
        expect(schedules.claim).toHaveBeenCalledTimes(1);
        expect(schedules.recordRun).toHaveBeenCalledWith('sch-1', {
            lastRunAt: now.toISOString(),
            lastError:
                'The model picked for this scan is not in your AI providers any more.',
        });
    });

    it('starts nothing for an organization the deep scan is not enabled for', async () => {
        const { useCase, schedules, start, gate } = setup();
        gate.isEnabledFor.mockResolvedValue(false);

        await useCase.runDue(now);

        expect(start.execute).not.toHaveBeenCalled();
        expect(schedules.recordRun).toHaveBeenCalledWith(
            'sch-1',
            expect.objectContaining({
                lastError: DEEP_SCAN_NOT_ENABLED_MESSAGE,
            }),
        );
    });

    it('saves a schedule with its first run and incremental by default', async () => {
        const { useCase, schedules } = setup();

        await useCase.save(
            {
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                repositoryId: 'repo-1',
                cadence: 'weekly',
                budget: { maxUsd: 10 },
            },
            new Date('2026-11-24T15:00:00Z'),
        );

        expect(schedules.save).toHaveBeenCalledWith(
            'org-1',
            repositoryKey,
            expect.objectContaining({
                cadence: 'weekly',
                mode: 'incremental',
                nextRunAt: '2026-11-25T03:00:00.000Z',
            }),
        );
    });

    it('leaves the stored state alone when saved without saying, in the write itself', async () => {
        const { useCase, schedules } = setup();
        const input = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repositoryId: 'repo-1',
            cadence: 'daily' as const,
            budget: { maxUsd: 5 },
        };

        // A paused schedule on record: its state is never copied from the read.
        schedules.find.mockResolvedValue(schedule({ enabled: false }));

        await useCase.save(input);
        await useCase.save({ ...input, enabled: false });

        expect(schedules.save.mock.calls[0][2].enabled).toBeUndefined();
        expect(schedules.save.mock.calls[1][2]).toMatchObject({
            enabled: false,
        });
    });

    it('pauses a schedule without touching its settings', async () => {
        const { useCase, schedules } = setup();
        schedules.find.mockResolvedValue(schedule());

        await useCase.setEnabled(
            { organizationId: 'org-1', teamId: 'team-1' },
            'repo-1',
            false,
            now,
        );

        expect(schedules.setEnabled).toHaveBeenCalledWith(
            'org-1',
            repositoryKey,
            false,
            undefined,
        );
        expect(schedules.save).not.toHaveBeenCalled();
    });

    it('resumes a schedule at its next time from now, not at once for the run it missed', async () => {
        const { useCase, schedules } = setup();
        schedules.find.mockResolvedValue(
            schedule({
                cadence: 'weekly',
                enabled: false,
                nextRunAt: '2026-11-01T03:00:00.000Z',
            }),
        );

        await useCase.setEnabled(
            { organizationId: 'org-1', teamId: 'team-1' },
            'repo-1',
            true,
            now,
        );

        expect(schedules.setEnabled).toHaveBeenCalledWith(
            'org-1',
            repositoryKey,
            true,
            new Date('2026-11-25T03:00:00.000Z'),
        );
    });

    it('says when the repository has no schedule to pause', async () => {
        const { useCase, schedules } = setup();
        schedules.find.mockResolvedValue(null);

        await expect(
            useCase.setEnabled(
                { organizationId: 'org-1', teamId: 'team-1' },
                'repo-1',
                false,
                now,
            ),
        ).rejects.toThrow('This repository has no deep scan schedule.');
        expect(schedules.setEnabled).not.toHaveBeenCalled();
    });

    it('refuses a limit the model cannot be held to when saved, not at its first run', async () => {
        const { useCase, schedules, start } = setup();
        start.scanModelFor.mockRejectedValue(
            new Error(
                'Your model has no known price, so the scan cannot be capped in USD.',
            ),
        );

        await expect(
            useCase.save({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                repositoryId: 'repo-1',
                cadence: 'daily',
                budget: { maxUsd: 5 },
                modelId: 'm-unpriced',
            }),
        ).rejects.toThrow('no known price');
        expect(start.scanModelFor).toHaveBeenCalledWith(
            { organizationId: 'org-1', teamId: 'team-1' },
            { maxUsd: 5 },
            'm-unpriced',
        );
        expect(schedules.save).not.toHaveBeenCalled();
    });

    it('keeps the next run when an edit leaves the cadence as it was, so an edit is not a paid run', async () => {
        const { useCase, schedules } = setup();
        schedules.find.mockResolvedValue(
            schedule({
                cadence: 'weekly',
                lastRunAt: '2026-11-23T03:00:00.000Z',
                nextRunAt: '2026-11-30T03:00:00.000Z',
            }),
        );
        const input = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repositoryId: 'repo-1',
            budget: { maxUsd: 20 },
        };

        await useCase.save({ ...input, cadence: 'weekly' }, now);
        await useCase.save({ ...input, cadence: 'daily' }, now);

        // Not written at all: the stored time stays, whatever moved it.
        expect(schedules.save.mock.calls[0][2].nextRunAt).toBeUndefined();
        // A new cadence counts from now on: daily, the next 03:00.
        expect(schedules.save.mock.calls[1][2].nextRunAt).toBe(
            '2026-11-25T03:00:00.000Z',
        );
    });

    it('refuses a schedule without a spend limit', async () => {
        const { useCase, schedules } = setup();

        await expect(
            useCase.save({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                repositoryId: 'repo-1',
                cadence: 'daily',
                budget: {},
            }),
        ).rejects.toThrow('needs a spend limit');
        expect(schedules.save).not.toHaveBeenCalled();
    });

    it('lists only the schedules of repositories the caller sees', async () => {
        const { useCase } = setup();

        const got = await useCase.list('org-1', ['repo-2']);

        expect(got.map((s) => s.repository.id)).toEqual(['repo-2']);
    });

    it('lists a schedule only when its whole repository identity is visible, not just its id', async () => {
        const { useCase, schedules, scans } = setup();
        schedules.list.mockResolvedValue([
            schedule(),
            schedule({
                uuid: 'sch-other-host',
                repository: { ...repositoryKey, host: 'git.acme.io' },
            }),
            schedule({
                uuid: 'sch-other-platform',
                repository: { ...repositoryKey, platform: 'GITLAB' },
            }),
        ]);

        const got = await useCase.list('org-1', ['repo-1']);

        expect(scans.repositoryScope).toHaveBeenCalledWith('org-1', ['repo-1']);
        expect(got).toEqual([schedule()]);
    });

    it('lists every schedule for a caller who sees every repository', async () => {
        const { useCase } = setup();

        const got = await useCase.list('org-1');

        expect(got.map((s) => s.uuid)).toEqual(['sch-1', 'sch-2']);
    });
});
