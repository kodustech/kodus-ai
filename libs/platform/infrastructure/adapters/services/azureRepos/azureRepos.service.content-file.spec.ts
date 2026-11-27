import { AzureReposService } from './azureRepos.service';

describe('AzureReposService.getRepositoryContentFile — throwOnReadError', () => {
    const axiosError = (status: number) =>
        Object.assign(new Error(`Request failed with status ${status}`), {
            isAxiosError: true,
            response: { status },
        });

    const makeService = (readFile: jest.Mock) => {
        const helper = {
            getRepositoryContentFile: readFile,
            getCommitsForPullRequest: jest.fn(),
        };
        const service = new AzureReposService(
            {} as any,
            {} as any,
            {} as any,
            helper as any,
            {} as any,
            undefined,
        );
        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
            orgName: 'o',
            token: 't',
        });
        jest.spyOn(
            service as any,
            'getProjectIdFromRepository',
        ).mockResolvedValue('project-1');
        (service as any).logger = {
            log: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
        return service;
    };

    const readConfig = (
        service: AzureReposService,
        throwOnReadError?: boolean,
    ) =>
        service.getRepositoryContentFile({
            organizationAndTeamData: { organizationId: 'org-1', teamId: 't' },
            repository: { id: 'repo-1', name: 'api', project: { id: 'p' } },
            file: { filename: 'kodus-config.yml' },
            pullRequest: {
                head: { ref: 'main' },
                base: { ref: 'main' },
            } as any,
            throwOnReadError,
        });

    it('rejects on a provider failure', async () => {
        const error = axiosError(502);
        const service = makeService(jest.fn().mockRejectedValue(error));

        await expect(readConfig(service, true)).rejects.toBe(error);
    });

    it('still answers a missing file as empty content', async () => {
        const service = makeService(
            jest.fn().mockRejectedValue(axiosError(404)),
        );

        const result = await readConfig(service, true);

        expect(result?.data?.content).toBe('');
    });

    it('swallows the failure without the flag', async () => {
        const service = makeService(
            jest.fn().mockRejectedValue(axiosError(429)),
        );

        const result = await readConfig(service);

        expect(result?.data?.content).toBe('');
    });
});
