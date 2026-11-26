import axios from 'axios';
import { BadRequestException } from '@nestjs/common';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { GitlabService } from '../gitlab.service';

jest.mock('axios');
jest.mock('@libs/common/utils/crypto', () => ({
    encrypt: (value: string) => `enc:${value}`,
    decrypt: (value: string) => value,
}));
jest.mock('../git-server-url.guard', () => ({
    assertGitServerUrlAllowed: jest.fn(),
    gitServerRefusal: jest.fn(),
}));
jest.mock('@libs/llm/gateway-address-guard', () => ({
    integrationRequestGuard: () => ({}),
}));

const workspace = { organizationId: 'org-1', teamId: 'team-1' };

/**
 * A GitLab connect whose "new connection" intent was lost must not rewrite
 * the workspace's oldest GitLab connection (a gitlab.com group added while a
 * self-hosted connection exists would overwrite its credentials).
 */
describe('GitLab connect — which connection it rewrites', () => {
    const build = (connectionToUpdate: jest.Mock) => {
        const service = Object.create(GitlabService.prototype) as any;
        service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
        service.integrationService = { connectionToUpdate };
        service.checkRepositoryPermissions = jest
            .fn()
            .mockResolvedValue({ success: true });
        service.handleIntegration = jest.fn().mockResolvedValue('gl-a');
        (axios.get as jest.Mock).mockResolvedValue({ data: { id: 1 } });
        return service;
    };

    it('asks for the connection to rewrite with the named connection and the intent', async () => {
        const connectionToUpdate = jest
            .fn()
            .mockResolvedValue({ uuid: 'gl-a' });
        const service = build(connectionToUpdate);

        await service.authenticateWithToken({
            token: 'glpat',
            organizationAndTeamData: workspace,
            newConnection: true,
        });

        expect(connectionToUpdate.mock.calls).toEqual([
            [workspace, PlatformType.GITLAB, true],
        ]);
        expect(service.handleIntegration).toHaveBeenCalledWith(
            { uuid: 'gl-a' },
            expect.anything(),
            workspace,
        );
    });

    it('rewrites nothing while several GitLab connections match and none is named', async () => {
        const service = build(
            jest
                .fn()
                .mockRejectedValue(
                    new BadRequestException('several connections'),
                ),
        );

        await expect(
            service.authenticateWithToken({
                token: 'glpat',
                organizationAndTeamData: workspace,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(service.handleIntegration).not.toHaveBeenCalled();
    });
});
