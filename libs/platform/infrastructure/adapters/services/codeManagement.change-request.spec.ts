import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { CodeManagementService } from './codeManagement.service';

const REASON = 'The critical findings behind this request are resolved.';
const params = {
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    repository: { id: 'repo-1', name: 'acme/api' },
    prNumber: 7,
    reason: REASON,
};
const NOTE = 'Kody takes this request back once the findings above are resolved.';

/** The service without its constructor: only what a test hands it. */
const make = <T extends object>(
    cls: { prototype: T },
    overrides: Record<string, unknown>,
) => {
    const service = Object.create(cls.prototype) as T;
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    for (const [key, value] of Object.entries({ logger, ...overrides })) {
        Object.defineProperty(service, key, { value, writable: true });
    }
    return service;
};

const build = (provider: Record<string, unknown> | undefined) => {
    const getCodeManagementService = jest.fn().mockReturnValue(provider);
    const getTypeIntegration = jest.fn().mockResolvedValue(PlatformType.FORGEJO);
    const service = make(CodeManagementService, {
        platformIntegrationFactory: { getCodeManagementService },
        getTypeIntegration,
    }) as any;
    return { service, getCodeManagementService, getTypeIntegration };
};

describe('CodeManagementService — Kody change request', () => {
    describe('dismissOwnPullRequestChangeRequests', () => {
        it('asks the host named by the caller, without looking the integration up', async () => {
            const provider = {
                dismissOwnPullRequestChangeRequests: jest.fn().mockResolvedValue(2),
            };
            const { service, getCodeManagementService, getTypeIntegration } =
                build(provider);

            await expect(
                service.dismissOwnPullRequestChangeRequests(
                    params,
                    PlatformType.GITHUB,
                ),
            ).resolves.toBe(2);
            expect(getTypeIntegration).not.toHaveBeenCalled();
            expect(getCodeManagementService).toHaveBeenCalledWith(
                PlatformType.GITHUB,
            );
            expect(
                provider.dismissOwnPullRequestChangeRequests,
            ).toHaveBeenCalledWith(params);
        });

        it('looks the host up when the caller does not name it', async () => {
            const provider = {
                dismissOwnPullRequestChangeRequests: jest.fn().mockResolvedValue(1),
            };
            const { service, getCodeManagementService, getTypeIntegration } =
                build(provider);

            await service.dismissOwnPullRequestChangeRequests(params);

            expect(getTypeIntegration).toHaveBeenCalledWith(
                params.organizationAndTeamData,
            );
            expect(getCodeManagementService).toHaveBeenCalledWith(
                PlatformType.FORGEJO,
            );
        });

        it.each([[undefined], [{}]])(
            'fails on a host that cannot withdraw a change request (%p)',
            async (provider) => {
                const { service } = build(provider);

                await expect(
                    service.dismissOwnPullRequestChangeRequests(
                        params,
                        PlatformType.GITLAB,
                    ),
                ).rejects.toThrow(
                    `Change request withdrawal is unavailable on ${PlatformType.GITLAB}`,
                );
            },
        );
    });

    describe('isOwnAccount', () => {
        const input = {
            organizationAndTeamData: params.organizationAndTeamData,
            account: { login: 'kody-ai[bot]', node_id: 'BOT_kody' },
        };

        it.each([true, false])('passes on what the host answers (%s)', async (answer) => {
            const provider = { isOwnAccount: jest.fn().mockResolvedValue(answer) };
            const { service, getTypeIntegration } = build(provider);

            await expect(
                service.isOwnAccount(input, PlatformType.GITHUB),
            ).resolves.toBe(answer);
            expect(provider.isOwnAccount).toHaveBeenCalledWith(input);
            expect(getTypeIntegration).not.toHaveBeenCalled();
        });

        it.each([[undefined], [{}]])(
            'takes the account for somebody else on a host that cannot tell (%p)',
            async (provider) => {
                const { service, getTypeIntegration } = build(provider);

                await expect(service.isOwnAccount(input)).resolves.toBe(false);
                expect(getTypeIntegration).toHaveBeenCalledWith(
                    input.organizationAndTeamData,
                );
            },
        );
    });
});
