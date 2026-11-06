import { AstGraphStatus } from '@libs/code-review/infrastructure/adapters/repositories/schemas/repository.model';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';

import { RepositoryConnectionService } from './repository-connection.service';

const orgTeam = { organizationId: 'org-1', teamId: 'team-1' };

describe('RepositoryConnectionService', () => {
    let jobQueueService: { enqueue: jest.Mock; listJobs: jest.Mock };
    let repositoryService: { findOrCreate: jest.Mock; findByExternalId: jest.Mock };
    let integrationConfigService: { findOne: jest.Mock };
    let backfill: { execute: jest.Mock };
    let telemetry: { repositoryConnected: jest.Mock };
    let service: RepositoryConnectionService;

    beforeEach(() => {
        jobQueueService = {
            enqueue: jest.fn().mockResolvedValue('job-1'),
            listJobs: jest.fn().mockResolvedValue({ data: [], total: 0 }),
        };
        repositoryService = {
            findOrCreate: jest.fn(async (p) => ({
                uuid: `rec-${p.externalId}`,
                externalId: p.externalId,
                name: p.name,
                fullName: p.fullName,
                platform: p.platform,
                defaultBranch: 'main',
                astGraphStatus: AstGraphStatus.PENDING,
            })),
            findByExternalId: jest.fn(),
        };
        integrationConfigService = {
            findOne: jest.fn().mockResolvedValue({ uuid: 'repos-config-1' }),
        };
        backfill = { execute: jest.fn().mockResolvedValue(undefined) };
        telemetry = { repositoryConnected: jest.fn() };
        service = new RepositoryConnectionService(
            jobQueueService as any,
            repositoryService as any,
            integrationConfigService as any,
            backfill as any,
            telemetry as any,
        );
    });

    it('registers repository records under the team repositories config row, not the team id', async () => {
        await service.registerRepositoryRecords({
            organizationAndTeamData: orgTeam,
            platform: 'gitlab',
            repositories: [
                { id: '7', name: 'acme/api', full_name: 'acme/api' } as any,
            ],
        });

        expect(integrationConfigService.findOne).toHaveBeenCalledWith({
            team: { uuid: 'team-1' },
            configKey: IntegrationConfigKey.REPOSITORIES,
        });
        expect(repositoryService.findOrCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                integrationConfigId: 'repos-config-1',
                externalId: '7',
                fullName: 'acme/api',
                platform: 'gitlab',
            }),
        );
        expect(telemetry.repositoryConnected).toHaveBeenCalledTimes(1);
    });

    it.each([
        [AstGraphStatus.PENDING, true],
        [AstGraphStatus.FAILED, true],
        [AstGraphStatus.BUILDING, false],
        [AstGraphStatus.READY, false],
    ])('enqueues an AST build for a %s record: %s', async (status, expected) => {
        const enqueued = await service.enqueueAstBuild({
            organizationAndTeamData: orgTeam,
            record: {
                uuid: 'rec-1',
                astGraphStatus: status,
                defaultBranch: 'main',
                fullName: 'acme/api',
                platform: 'gitlab',
            } as any,
            cloneUrl: 'https://git.example/acme/api.git',
        });

        expect(enqueued).toBe(expected);
        expect(jobQueueService.enqueue).toHaveBeenCalledTimes(expected ? 1 : 0);
        if (expected) {
            expect(jobQueueService.enqueue).toHaveBeenCalledWith(
                expect.objectContaining({
                    workflowType: WorkflowType.AST_GRAPH_BUILD,
                    payload: expect.objectContaining({ repositoryId: 'rec-1' }),
                }),
            );
        }
    });

    it('counts the team AST builds that are queued or running, ignoring stale ones', async () => {
        const now = Date.now();
        jobQueueService.listJobs.mockImplementation(async ({ status }) => ({
            data:
                status === JobStatus.PENDING
                    ? [
                          { createdAt: new Date(now - 60_000) },
                          { createdAt: new Date(now - 10 * 3_600_000) },
                      ]
                    : [{ createdAt: new Date(now - 120_000) }],
            total: 0,
        }));

        await expect(service.countInFlightAstBuilds(orgTeam)).resolves.toBe(2);
        expect(jobQueueService.listJobs).toHaveBeenCalledWith(
            expect.objectContaining({
                workflowType: WorkflowType.AST_GRAPH_BUILD,
                teamId: 'team-1',
                status: JobStatus.PENDING,
            }),
        );
    });

    it('runs one history backfill at a time per team', async () => {
        let finish: () => void = () => undefined;
        backfill.execute.mockReturnValueOnce(
            new Promise<void>((resolve) => {
                finish = resolve;
            }),
        );
        const repos = [{ id: '1', name: 'a' } as any];

        expect(service.startHistoricalBackfill(orgTeam, repos)).toBe(true);
        expect(service.startHistoricalBackfill(orgTeam, repos)).toBe(false);

        finish();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        expect(service.startHistoricalBackfill(orgTeam, repos)).toBe(true);
    });
});
