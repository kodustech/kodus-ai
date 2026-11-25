import { ConflictException } from '@nestjs/common';

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
        save: jest.fn(async (_org: string, _key: unknown, s: any) => ({ uuid: 'sch-1', ...s })),
        find: jest.fn(),
        list: jest.fn(async () => [schedule(), schedule({ uuid: 'sch-2', repository: { ...repositoryKey, id: 'repo-2' } })]),
        remove: jest.fn(async () => true),
        setEnabled: jest.fn(async (_org: string, _key: unknown, enabled: boolean, next?: Date) =>
            schedule({ enabled, ...(next ? { nextRunAt: next.toISOString() } : {}) }),
        ),
        findDue: jest.fn(async () => [schedule()]),
        claim: jest.fn(async () => true),
        recordRun: jest.fn(async () => undefined),
    };
    const start = {
        repositoryKeyOf: jest.fn(async () => repositoryKey),
        scanModelFor: jest.fn(async () => ({ model: {}, rates: {} })),
        execute: jest.fn(async () => ({ uuid: 'scan-9' })),
    };
    const gate = { isEnabledFor: jest.fn(async () => true) };
    const useCase = new SecurityScanSchedulesUseCase(
        schedules as any,
        start as any,
        gate as any,
    );
    return { useCase, schedules, start, gate };
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
                organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
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

    it('says why a due scan did not start, and waits for its next time', async () => {
        const { useCase, schedules, start } = setup();
        start.execute.mockRejectedValue(
            new ConflictException('A security scan of this repository is already running.'),
        );

        expect(await useCase.runDue(now)).toBe(0);
        expect(schedules.recordRun).toHaveBeenCalledWith('sch-1', {
            lastRunAt: now.toISOString(),
            lastError: 'A security scan of this repository is already running.',
        });
    });

    it('starts nothing for an organization the deep scan is not enabled for', async () => {
        const { useCase, schedules, start, gate } = setup();
        gate.isEnabledFor.mockResolvedValue(false);

        await useCase.runDue(now);

        expect(start.execute).not.toHaveBeenCalled();
        expect(schedules.recordRun).toHaveBeenCalledWith(
            'sch-1',
            expect.objectContaining({ lastError: DEEP_SCAN_NOT_ENABLED_MESSAGE }),
        );
    });

    it('saves a schedule with its first run and incremental by default', async () => {
        const { useCase, schedules } = setup();

        await useCase.save(
            {
                organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
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

    it('leaves the stored state alone when saved without saying, without reading it first', async () => {
        const { useCase, schedules } = setup();
        const input = {
            organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
            repositoryId: 'repo-1',
            cadence: 'daily' as const,
            budget: { maxUsd: 5 },
        };

        await useCase.save(input);
        await useCase.save({ ...input, enabled: false });

        expect(schedules.find).not.toHaveBeenCalled();
        expect(schedules.save.mock.calls[0][2].enabled).toBeUndefined();
        expect(schedules.save.mock.calls[1][2]).toMatchObject({ enabled: false });
    });

    it('pauses a schedule without touching its settings', async () => {
        const { useCase, schedules } = setup();
        schedules.find.mockResolvedValue(schedule());

        await useCase.setEnabled({ organizationId: 'org-1', teamId: 'team-1' }, 'repo-1', false, now);

        expect(schedules.setEnabled).toHaveBeenCalledWith('org-1', repositoryKey, false, undefined);
        expect(schedules.save).not.toHaveBeenCalled();
    });

    it('resumes a schedule at its next time from now, not at once for the run it missed', async () => {
        const { useCase, schedules } = setup();
        schedules.find.mockResolvedValue(schedule({ cadence: 'weekly', enabled: false, nextRunAt: '2026-11-01T03:00:00.000Z' }));

        await useCase.setEnabled({ organizationId: 'org-1', teamId: 'team-1' }, 'repo-1', true, now);

        expect(schedules.setEnabled).toHaveBeenCalledWith('org-1', repositoryKey, true, new Date('2026-11-25T03:00:00.000Z'));
    });

    it('says when the repository has no schedule to pause', async () => {
        const { useCase, schedules } = setup();
        schedules.find.mockResolvedValue(null);

        await expect(
            useCase.setEnabled({ organizationId: 'org-1', teamId: 'team-1' }, 'repo-1', false, now),
        ).rejects.toThrow('This repository has no deep scan schedule.');
        expect(schedules.setEnabled).not.toHaveBeenCalled();
    });

    it('refuses a limit the model cannot be held to when saved, not at its first run', async () => {
        const { useCase, schedules, start } = setup();
        start.scanModelFor.mockRejectedValue(new Error('Your model has no known price, so the scan cannot be capped in USD.'));

        await expect(
            useCase.save({
                organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
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

    it('refuses a schedule without a spend limit', async () => {
        const { useCase, schedules } = setup();

        await expect(
            useCase.save({
                organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
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
});
