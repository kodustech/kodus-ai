import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    GITHUB_SERVICE_TOKEN,
    IGithubService,
} from '@libs/platform/domain/github/contracts/github.service.contract';

/**
 * GitHub's authorization page for linking an installation of the Kodus App,
 * bound to the signed-in user and their organization.
 */
export class GetInstallationAuthorizationUseCase implements IUseCase {
    constructor(
        @Inject(GITHUB_SERVICE_TOKEN)
        private readonly githubService: IGithubService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { uuid: string; organization: { uuid: string } };
        },
    ) {}

    public async execute(installationId: string) {
        return this.githubService.getInstallationAuthorizationUrl({
            installationId,
            userId: this.request.user?.uuid,
            organizationId: this.request.user?.organization?.uuid,
        });
    }
}
