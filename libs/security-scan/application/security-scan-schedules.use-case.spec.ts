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
        findDue: jest.fn(async () => [schedule()]),
        claim: jest.fn(async () => true),
        recordRun: jest.fn(async () => undefined),
    };
    const start = {
        repositoryKeyOf: jest.fn(async () => repositoryKey),
        execute: jest.fn(async () => ({ uuid: 'scan-9' })),
    };
    const gate = { isEnabledFor: jest.fn(async () => true) };
    const useCase = new SecurityScanSchedulesUseCase(schedules as any, start as any, gate as any);
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
                enabled: true,
                nextRunAt: '2026-11-25T03:00:00.000Z',
            }),
        );
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

describe('SecurityScanSchedulesUseCase: filing a finished run', () => {
    const exporting = schedule({
        lastScanId: 'scan-9',
        lastRunAt: '2026-11-24T03:00:00.000Z',
        exportTo: { integrationId: 'int-linear', destinationNote: 'team SEC', minSeverity: 'high' },
    });
    function withExport(scanOver: Record<string, unknown> = {}, found: any[] = [{ uuid: 'i1' }, { uuid: 'i2' }]) {
        const schedules = {
            findExporting: jest.fn(async () => [exporting]),
            recordRun: jest.fn(async () => undefined),
        };
        const scans = {
            findById: jest.fn(async () => ({
                uuid: 'scan-9',
                status: 'completed',
                repository: { id: 'repo-1' },
                startedAt: '2026-11-24T03:00:05.000Z',
                finishedAt: '2026-11-24T03:40:00.000Z',
                createdAt: '2026-11-24T03:00:00.000Z',
                ...scanOver,
            })),
            update: jest.fn(async () => null),
        };
        const issues = { findScanIssuesToExport: jest.fn(async () => found) };
        const exporter = {
            execute: jest.fn(async ({ issueIds }: any) =>
                issueIds.map((issueId: string) => ({ issueId, status: 'created', url: `https://linear.app/${issueId}` })),
            ),
        };
        const useCase = new SecurityScanSchedulesUseCase(
            schedules as any,
            {} as any,
            {} as any,
            scans as any,
            issues as any,
            exporter as any,
        );
        return { useCase, schedules, scans, issues, exporter };
    }

    it("files the run's new findings from the schedule's severity up, once", async () => {
        const { useCase, scans, issues, exporter } = withExport();

        expect(await useCase.exportFinished()).toBe(2);

        expect(issues.findScanIssuesToExport).toHaveBeenCalledWith({
            organizationId: 'org-1',
            repositoryId: 'repo-1',
            since: '2026-11-24T03:00:05.000Z',
            until: '2026-11-24T03:40:00.000Z',
            severities: ['high', 'critical'],
            integrationId: 'int-linear',
            limit: 25,
        });
        expect(exporter.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                issueIds: ['i1', 'i2'],
                integrationId: 'int-linear',
                destinationNote: 'team SEC',
                requestedBy: 'schedule',
            }),
        );
        expect(scans.update).toHaveBeenCalledWith('scan-9', { exportedAt: expect.any(String) });
    });

    it('waits for the run to end', async () => {
        const { useCase, exporter } = withExport({ status: 'running' });

        await useCase.exportFinished();

        expect(exporter.execute).not.toHaveBeenCalled();
    });

    it('does not file a run twice', async () => {
        const { useCase, exporter } = withExport({ exportedAt: '2026-11-24T04:00:00.000Z' });

        await useCase.exportFinished();

        expect(exporter.execute).not.toHaveBeenCalled();
    });

    it('says on the schedule why nothing could be filed, and does not retry it forever', async () => {
        const { useCase, schedules, scans, exporter } = withExport();
        exporter.execute.mockResolvedValue([
            { issueId: 'i1', status: 'failed', error: 'the destination is public' },
        ] as any);

        await useCase.exportFinished();

        expect(scans.update).toHaveBeenCalledWith('scan-9', { exportedAt: expect.any(String) });
        expect(schedules.recordRun).toHaveBeenCalledWith(
            'sch-1',
            expect.objectContaining({ lastError: 'the destination is public' }),
        );
    });
});
