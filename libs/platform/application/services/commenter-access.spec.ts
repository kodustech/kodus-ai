import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { commenterOf, reviewCommandAccess } from './commenter-access';

const org = { organizationId: 'org-1', teamId: 'team-1' };

const github = (association: string, login = 'dev') => ({
    platformType: PlatformType.GITHUB,
    payload: {
        sender: { login, id: 1 },
        comment: { author_association: association },
        repository: { id: 9, name: 'ledger', owner: { login: 'acme' } },
    },
});

const service = (canWrite?: boolean | Error, members: unknown[] = []) => ({
    userCanWrite: jest.fn(async () => {
        if (canWrite instanceof Error) throw canWrite;
        return canWrite;
    }),
    getListMembers: jest.fn(async () => members),
});

describe('reviewCommandAccess', () => {
    it('asks nothing for a command that is not Heavy or Ultra', async () => {
        const codeManagement = service(true);
        for (const mode of [undefined, 'balanced']) {
            await expect(
                reviewCommandAccess(
                    codeManagement as any,
                    github('OWNER'),
                    org,
                    mode,
                ),
            ).resolves.toBeUndefined();
        }
        expect(codeManagement.userCanWrite).not.toHaveBeenCalled();
    });

    it('a stranger or contributor on GitHub has none, without asking the host', async () => {
        const codeManagement = service(true);
        for (const association of ['NONE', 'CONTRIBUTOR', 'FIRST_TIMER']) {
            await expect(
                reviewCommandAccess(
                    codeManagement as any,
                    github(association),
                    org,
                    'ultra',
                ),
            ).resolves.toBe('none');
        }
        expect(codeManagement.userCanWrite).not.toHaveBeenCalled();
    });

    it('a collaborator is asked for: write or none, as the host says', async () => {
        await expect(
            reviewCommandAccess(
                service(true) as any,
                github('COLLABORATOR'),
                org,
                'heavy',
            ),
        ).resolves.toBe('write');
        await expect(
            reviewCommandAccess(
                service(false) as any,
                github('MEMBER'),
                org,
                'heavy',
            ),
        ).resolves.toBe('none');
    });

    it('is unknown when the host fails or cannot say', async () => {
        await expect(
            reviewCommandAccess(
                service(new Error('502')) as any,
                github('OWNER'),
                org,
                'ultra',
            ),
        ).resolves.toBe('unknown');
        await expect(
            reviewCommandAccess(
                service(undefined) as any,
                github('OWNER'),
                org,
                'ultra',
            ),
        ).resolves.toBe('unknown');
    });

    it('is unknown without an organization to ask with', async () => {
        const codeManagement = service(true);
        await expect(
            reviewCommandAccess(
                codeManagement as any,
                github('OWNER'),
                undefined,
                'ultra',
            ),
        ).resolves.toBe('unknown');
        expect(codeManagement.userCanWrite).not.toHaveBeenCalled();
    });

    it("reads the workspace's members on Bitbucket", async () => {
        const bitbucket = {
            platformType: PlatformType.BITBUCKET,
            payload: { actor: { uuid: '{abc}', display_name: 'Dev' } },
        };
        await expect(
            reviewCommandAccess(
                service(undefined, [{ id: '{abc}' }]) as any,
                bitbucket,
                org,
                'ultra',
            ),
        ).resolves.toBe('write');
        await expect(
            reviewCommandAccess(
                service(undefined, [{ id: '{zzz}' }]) as any,
                bitbucket,
                org,
                'ultra',
            ),
        ).resolves.toBe('none');
    });

    it("does not take a Bitbucket member's display name for their id", async () => {
        const impostor = {
            platformType: PlatformType.BITBUCKET,
            payload: { actor: { uuid: '{zzz}', display_name: 'Maintainer' } },
        };
        await expect(
            reviewCommandAccess(
                service(undefined, [
                    { id: '{abc}', name: 'Maintainer' },
                ]) as any,
                impostor,
                org,
                'ultra',
            ),
        ).resolves.toBe('none');
    });

    it('asks Bitbucket Data Center for the effective permission, by username', async () => {
        const dataCenter = {
            platformType: PlatformType.BITBUCKET,
            payload: {
                isDataCenterEvent: true,
                actor: { name: 'dev', id: 7, displayName: 'Dev' },
                pullrequest: { toRef: { repository: { id: 42 } } },
            },
        };
        for (const [canWrite, access] of [
            [true, 'write'],
            [false, 'none'],
            [undefined, 'unknown'],
        ] as const) {
            const codeManagement = service(canWrite, [{ id: 'dev' }]);
            await expect(
                reviewCommandAccess(
                    codeManagement as any,
                    dataCenter,
                    org,
                    'ultra',
                ),
            ).resolves.toBe(access);
            expect(codeManagement.userCanWrite).toHaveBeenCalledWith(
                expect.objectContaining({
                    login: 'dev',
                    repository: { id: '42' },
                }),
                PlatformType.BITBUCKET,
            );
            expect(codeManagement.getListMembers).not.toHaveBeenCalled();
        }
    });

    it("asks Forgejo for the commenter's permission on the repository", async () => {
        const codeManagement = service(false, [{ id: 3, name: 'dev' }]);
        await expect(
            reviewCommandAccess(
                codeManagement as any,
                {
                    platformType: PlatformType.FORGEJO,
                    payload: {
                        comment: { user: { login: 'dev', id: 3 } },
                        repository: { id: 9, full_name: 'acme/ledger' },
                    },
                },
                org,
                'heavy',
            ),
        ).resolves.toBe('none');
        expect(codeManagement.userCanWrite).toHaveBeenCalledWith(
            expect.objectContaining({
                login: 'dev',
                repository: { id: '9', name: 'acme/ledger' },
            }),
            PlatformType.FORGEJO,
        );
        expect(codeManagement.getListMembers).not.toHaveBeenCalled();
    });

    it("reads the organization's members on Azure Repos", async () => {
        const azure = (displayName: string) => ({
            platformType: PlatformType.AZURE_REPOS,
            payload: {
                resource: {
                    comment: { author: { id: 'guid-1', displayName } },
                    pullRequest: { repository: { id: 'r1', name: 'ledger' } },
                },
            },
        });
        const members = [{ id: 'aad.descriptor', name: 'Dev' }];
        await expect(
            reviewCommandAccess(
                service(undefined, members) as any,
                azure('Dev'),
                org,
                'heavy',
            ),
        ).resolves.toBe('write');
        await expect(
            reviewCommandAccess(
                service(undefined, members) as any,
                azure('Someone'),
                org,
                'heavy',
            ),
        ).resolves.toBe('none');
    });

    it('a Bitbucket actor known only by account_id is unknown, not a non-member', async () => {
        await expect(
            reviewCommandAccess(
                service(undefined, [{ id: 'abc', name: 'Dev' }]) as any,
                {
                    platformType: PlatformType.BITBUCKET,
                    payload: {
                        actor: { account_id: '557058:x', display_name: 'Dev' },
                    },
                },
                org,
                'ultra',
            ),
        ).resolves.toBe('unknown');
    });

    it('is unknown when the member list comes back empty or names no commenter', async () => {
        const bitbucket = {
            platformType: PlatformType.BITBUCKET,
            payload: { actor: { uuid: '{abc}' } },
        };
        await expect(
            reviewCommandAccess(
                service(undefined, []) as any,
                bitbucket,
                org,
                'ultra',
            ),
        ).resolves.toBe('unknown');
        const codeManagement = service(undefined, [{ id: '{abc}' }]);
        await expect(
            reviewCommandAccess(
                codeManagement as any,
                {
                    platformType: PlatformType.BITBUCKET,
                    payload: { actor: {} },
                },
                org,
                'ultra',
            ),
        ).resolves.toBe('unknown');
        expect(codeManagement.getListMembers).not.toHaveBeenCalled();
    });

    it('asks Bitbucket Cloud for a complete member list', async () => {
        const codeManagement = service(undefined, [{ id: '{abc}' }]);
        await reviewCommandAccess(
            codeManagement as any,
            {
                platformType: PlatformType.BITBUCKET,
                payload: { actor: { uuid: '{abc}' } },
            },
            org,
            'ultra',
        );
        expect(codeManagement.getListMembers).toHaveBeenCalledWith(
            expect.objectContaining({ requireComplete: true }),
            PlatformType.BITBUCKET,
        );
    });
});

describe('commenterOf', () => {
    it("reads Forgejo's commenter from the comment, not the event", () => {
        expect(
            commenterOf({
                platformType: PlatformType.FORGEJO,
                payload: {
                    comment: { user: { login: 'dev', id: 3 } },
                    sender: { login: 'bot', id: 1 },
                },
            }),
        ).toEqual({ login: 'dev', id: 3 });
    });
});
