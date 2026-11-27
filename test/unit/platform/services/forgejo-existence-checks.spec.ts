import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { AUTH_INTEGRATION_SERVICE_TOKEN } from '@libs/integrations/domain/authIntegrations/contracts/auth-integration.service.contracts';
import { INTEGRATION_CONFIG_SERVICE_TOKEN } from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { INTEGRATION_SERVICE_TOKEN } from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';


jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: jest.fn((value: string) => value),
    encrypt: jest.fn((value: string) => value),
}));

jest.mock('@llamaduck/forgejo-ts', () => ({
    repoGetBranch: jest.fn(),
    repoGetContents: jest.fn(),
    repoChangeFiles: jest.fn(),
}));

jest.mock('@llamaduck/forgejo-ts/client', () => ({
    createClient: jest.fn(() => ({})),
}));

describe('ForgejoService existence checks', () => {
    let service: any;
    let forgejo: {
        repoGetBranch: jest.Mock;
        repoGetContents: jest.Mock;
        repoChangeFiles: jest.Mock;
    };

    const client = {} as any;
    const repoInfo = { owner: 'acme', repo: 'config' };

    const mockSdkHttpError = (
        sdkCall: jest.Mock,
        status: number,
        error: object = { status },
    ): object => {
        sdkCall.mockImplementation((options?: { throwOnError?: boolean }) =>
            options?.throwOnError
                ? Promise.reject(error)
                : Promise.resolve({ error, response: { status } }),
        );

        return error;
    };

    beforeEach(async () => {
        forgejo = jest.requireMock('@llamaduck/forgejo-ts');

        const module = await import(
            '@libs/platform/infrastructure/adapters/services/forgejo.service'
        );

        const moduleRef = await Test.createTestingModule({
            providers: [
                (module as any).ForgejoService,
                { provide: ConfigService, useValue: { get: jest.fn() } },
                {
                    provide: INTEGRATION_SERVICE_TOKEN,
                    useValue: { findOne: jest.fn() },
                },
                {
                    provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
                    useValue: { findOne: jest.fn() },
                },
                {
                    provide: AUTH_INTEGRATION_SERVICE_TOKEN,
                    useValue: { findOne: jest.fn() },
                },
            ],
        }).compile();

        service = moduleRef.get((module as any).ForgejoService);
    });

    afterEach(() => {
        jest.clearAllMocks();
        forgejo.repoGetBranch.mockReset();
        forgejo.repoGetContents.mockReset();
        forgejo.repoChangeFiles.mockReset();
    });

    describe('checkForgejoBranchExists', () => {
        it('returns true when the branch is found', async () => {
            forgejo.repoGetBranch.mockResolvedValue({ data: {} });

            await expect(
                service.checkForgejoBranchExists(client, repoInfo, 'feature'),
            ).resolves.toBe(true);

            expect(forgejo.repoGetBranch).toHaveBeenCalledWith(
                expect.objectContaining({
                    path: { owner: 'acme', repo: 'config', branch: 'feature' },
                    throwOnError: true,
                }),
            );
        });

        it('returns false on a 404', async () => {
            mockSdkHttpError(forgejo.repoGetBranch, 404);

            await expect(
                service.checkForgejoBranchExists(client, repoInfo, 'missing'),
            ).resolves.toBe(false);
            expect(forgejo.repoGetBranch).toHaveBeenCalledWith(
                expect.objectContaining({ throwOnError: true }),
            );
        });

        it.each([401, 500])('rethrows a %i', async (status) => {
            const error = mockSdkHttpError(forgejo.repoGetBranch, status);

            await expect(
                service.checkForgejoBranchExists(client, repoInfo, 'feature'),
            ).rejects.toBe(error);
        });
    });

    describe('checkForgejoFileExists', () => {
        it('returns exists and sha for an existing file', async () => {
            forgejo.repoGetContents.mockResolvedValue({
                data: { sha: 'abc123' },
            });

            await expect(
                service.checkForgejoFileExists(
                    client,
                    repoInfo,
                    'main',
                    '/kodus-config.yml',
                ),
            ).resolves.toEqual({ exists: true, sha: 'abc123' });

            expect(forgejo.repoGetContents).toHaveBeenCalledWith(
                expect.objectContaining({
                    path: {
                        owner: 'acme',
                        repo: 'config',
                        filepath: 'kodus-config.yml',
                    },
                    query: { ref: 'main' },
                }),
            );
        });

        it('returns no sha when the path is a directory', async () => {
            forgejo.repoGetContents.mockResolvedValue({
                data: [{ sha: 'x' }],
            });

            await expect(
                service.checkForgejoFileExists(client, repoInfo, 'main', 'dir'),
            ).resolves.toEqual({ exists: true, sha: undefined });
        });

        it('returns exists false on a 404', async () => {
            mockSdkHttpError(forgejo.repoGetContents, 404);

            await expect(
                service.checkForgejoFileExists(client, repoInfo, 'main', 'a.yml'),
            ).resolves.toEqual({ exists: false });
            expect(forgejo.repoGetContents).toHaveBeenCalledWith(
                expect.objectContaining({ throwOnError: true }),
            );
        });

        it.each([401, 500])('rethrows a %i', async (status) => {
            const error = mockSdkHttpError(forgejo.repoGetContents, status);

            await expect(
                service.checkForgejoFileExists(client, repoInfo, 'main', 'a.yml'),
            ).rejects.toBe(error);
        });
    });

    describe('ensureBaseBranchExists', () => {
        const run = (author?: { name: string; email?: string }) =>
            service.ensureBaseBranchExists({
                client,
                repoInfo,
                baseBranch: 'main',
                author,
            });

        it('does nothing when the base branch already exists', async () => {
            forgejo.repoGetBranch.mockResolvedValue({ data: {} });

            await expect(run()).resolves.toBeUndefined();
            expect(forgejo.repoChangeFiles).not.toHaveBeenCalled();
        });

        it('seeds the base branch when it is missing', async () => {
            mockSdkHttpError(forgejo.repoGetBranch, 404);
            forgejo.repoChangeFiles.mockResolvedValue({ status: 201 });

            await run({ name: 'Kody' });

            const call = forgejo.repoChangeFiles.mock.calls[0][0];
            expect(call.throwOnError).toBe(true);
            expect(call.body.branch).toBe('main');
            expect(call.body.files).toHaveLength(1);
            expect(call.body.files[0].operation).toBe('create');
            expect(call.body.author).toEqual({
                name: 'Kody',
                email: 'kody@kodus.io',
            });
        });

        it('swallows a seed failure when a concurrent run created the branch', async () => {
            forgejo.repoGetBranch
                .mockImplementationOnce(() => Promise.reject({ status: 404 }))
                .mockResolvedValueOnce({ data: {} });
            mockSdkHttpError(
                forgejo.repoChangeFiles,
                409,
                new Error('conflict'),
            );

            await expect(run()).resolves.toBeUndefined();
        });

        it('rethrows the seed error when the branch still does not exist', async () => {
            const error = new Error('boom');
            mockSdkHttpError(forgejo.repoGetBranch, 404);
            mockSdkHttpError(forgejo.repoChangeFiles, 500, error);

            await expect(run()).rejects.toBe(error);
        });

        it('propagates a non-404 error from the branch check', async () => {
            const error = mockSdkHttpError(forgejo.repoGetBranch, 401);

            await expect(run()).rejects.toBe(error);
            expect(forgejo.repoChangeFiles).not.toHaveBeenCalled();
        });
    });

    describe('uploadFiles sha handling', () => {
        const organizationAndTeamData = {
            organizationId: 'org-123',
            teamId: 'team-456',
        };

        beforeEach(() => {
            jest.spyOn(service, 'getDefaultBranch').mockResolvedValue('main');
            jest.spyOn(service, 'getAuthDetails').mockResolvedValue({
                host: 'https://git.example.com',
                accessToken: 'token',
                authMode: 'token',
            });
            forgejo.repoChangeFiles.mockResolvedValue({ status: 200 });
        });

        const upload = (files: any[]) =>
            service.uploadFiles({
                organizationAndTeamData,
                repository: { id: '1', name: 'acme/config' },
                files,
            });

        it('passes throwOnError on the write call', async () => {
            forgejo.repoGetContents.mockResolvedValue({
                data: { sha: 'sha-1' },
            });

            await upload([{ path: 'a.yml', content: 'hi' }]);

            expect(forgejo.repoChangeFiles).toHaveBeenCalledWith(
                expect.objectContaining({ throwOnError: true }),
            );
        });

        it.each([422, 500])(
            'returns false when the write fails with %i',
            async (status) => {
                forgejo.repoGetContents.mockResolvedValue({
                    data: { sha: 'sha-1' },
                });
                mockSdkHttpError(forgejo.repoChangeFiles, status);

                await expect(
                    upload([{ path: 'a.yml', content: 'hi' }]),
                ).resolves.toBe(false);
            },
        );

        it.each([409, 422])(
            'retries once with fresh shas when the write conflicts with %i',
            async (status) => {
                forgejo.repoGetContents
                    .mockResolvedValueOnce({ data: { sha: 'stale-sha' } })
                    .mockResolvedValueOnce({ data: { sha: 'fresh-sha' } });
                forgejo.repoChangeFiles
                    .mockRejectedValueOnce({ status })
                    .mockResolvedValueOnce({ status: 200 });

                await expect(
                    upload([{ path: 'a.yml', content: 'hi' }]),
                ).resolves.toBe(true);

                expect(forgejo.repoGetContents).toHaveBeenCalledTimes(2);
                expect(forgejo.repoChangeFiles).toHaveBeenCalledTimes(2);
                const [first, second] = forgejo.repoChangeFiles.mock.calls;
                expect(first[0].body.files[0].sha).toBe('stale-sha');
                expect(second[0].body.files[0].sha).toBe('fresh-sha');
            },
        );

        it('returns false when the retry conflicts again', async () => {
            forgejo.repoGetContents.mockResolvedValue({
                data: { sha: 'sha-1' },
            });
            forgejo.repoChangeFiles.mockRejectedValue({ status: 409 });

            await expect(
                upload([{ path: 'a.yml', content: 'hi' }]),
            ).resolves.toBe(false);
            expect(forgejo.repoChangeFiles).toHaveBeenCalledTimes(2);
        });

        it('does not retry a non-conflict write failure', async () => {
            forgejo.repoGetContents.mockResolvedValue({
                data: { sha: 'sha-1' },
            });
            forgejo.repoChangeFiles.mockRejectedValue({ status: 500 });

            await expect(
                upload([{ path: 'a.yml', content: 'hi' }]),
            ).resolves.toBe(false);
            expect(forgejo.repoChangeFiles).toHaveBeenCalledTimes(1);
        });

        it('sends the existing sha on update', async () => {
            forgejo.repoGetContents.mockResolvedValue({
                data: { sha: 'sha-1' },
            });

            await expect(
                upload([{ path: 'a.yml', content: 'hi', operation: 'upsert' }]),
            ).resolves.toBe(true);

            const body = forgejo.repoChangeFiles.mock.calls[0][0].body;
            expect(body.files).toEqual([
                {
                    operation: 'update',
                    path: 'a.yml',
                    content: Buffer.from('hi').toString('base64'),
                    sha: 'sha-1',
                },
            ]);
        });

        it('creates without a sha when the file is missing', async () => {
            mockSdkHttpError(forgejo.repoGetContents, 404);

            await upload([{ path: 'a.yml', content: 'hi' }]);

            const [file] = forgejo.repoChangeFiles.mock.calls[0][0].body.files;
            expect(file.operation).toBe('create');
            expect(file).not.toHaveProperty('sha');
        });

        it('sends the existing sha on delete', async () => {
            forgejo.repoGetContents.mockResolvedValue({
                data: { sha: 'sha-2' },
            });

            await upload([{ path: 'a.yml', operation: 'delete' }]);

            const body = forgejo.repoChangeFiles.mock.calls[0][0].body;
            expect(body.files).toEqual([
                { operation: 'delete', path: 'a.yml', sha: 'sha-2' },
            ]);
        });

        it('skips deleting a missing file', async () => {
            mockSdkHttpError(forgejo.repoGetContents, 404);

            await expect(
                upload([{ path: 'a.yml', operation: 'delete' }]),
            ).resolves.toBe(true);
            expect(forgejo.repoChangeFiles).not.toHaveBeenCalled();
        });

        it.each([401, 500])(
            'returns false and does not write when the file check fails with %i',
            async (status) => {
                mockSdkHttpError(forgejo.repoGetContents, status);

                await expect(
                    upload([{ path: 'a.yml', content: 'hi' }]),
                ).resolves.toBe(false);
                expect(forgejo.repoChangeFiles).not.toHaveBeenCalled();
            },
        );
    });
});
