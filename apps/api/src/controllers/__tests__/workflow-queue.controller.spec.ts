import { WorkflowQueueController } from '../workflow-queue.controller';

describe('WorkflowQueueController', () => {
    const build = (job: Record<string, unknown> | null) => {
        const jobStatusService = {
            getJobStatus: jest.fn().mockResolvedValue(job),
            getJobDetail: jest
                .fn()
                .mockResolvedValue(job ? { job, executionHistory: [] } : null),
        };
        const controller = new WorkflowQueueController(
            jobStatusService as any,
            { user: { organization: { uuid: 'org-1' } } } as any,
        );
        return controller;
    };

    it("answers a job of the caller's organization", async () => {
        const controller = build({
            id: 'job-1',
            organizationAndTeamData: { organizationId: 'org-1' },
        });

        await expect(controller.getJobStatus('job-1')).resolves.toMatchObject({
            status: 200,
        });
        await expect(controller.getJobDetail('job-1')).resolves.toMatchObject({
            status: 200,
        });
    });

    it("answers another organization's job like an unknown one", async () => {
        const controller = build({
            id: 'job-1',
            organizationAndTeamData: { organizationId: 'org-2' },
        });

        await expect(controller.getJobStatus('job-1')).resolves.toEqual({
            status: 404,
            message: 'Job not found',
        });
        await expect(controller.getJobDetail('job-1')).resolves.toEqual({
            status: 404,
            message: 'Job not found',
        });
    });
});
