import { InstallationStatus } from '@/shared/domain/enums/github-installation-status.enum';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import {
    GITHUB_SERVICE_TOKEN,
    IGithubService,
} from '@/core/domain/github/contracts/github.service.contract';

export class CreateOrUpdateOrganizationNameUseCase implements IUseCase {
    constructor(
        @Inject(GITHUB_SERVICE_TOKEN)
        private readonly githubService: IGithubService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    public async execute(organizationName: string) {
        return this.githubService.updateInstallationItems(
            {
                organizationName,
                installationStatus: InstallationStatus.PENDING,
            },
            {
                organizationId: this.request.user.organization.uuid,
            },
        );
    }
}
