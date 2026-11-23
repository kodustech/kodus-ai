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

    it("reads the organization's members on Bitbucket and Azure Repos", async () => {
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
