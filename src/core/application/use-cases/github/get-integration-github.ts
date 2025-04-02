import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import {
    GITHUB_SERVICE_TOKEN,
    IGithubService,
} from '@/core/domain/github/contracts/github.service.contract';

export class GetIntegrationGithubUseCase implements IUseCase {
    constructor(
        @Inject(GITHUB_SERVICE_TOKEN)
        private readonly githubService: IGithubService,
    ) {}

    public async execute(installId) {
        const integration =
            await this.githubService.findOneByInstallId(installId);

        return {
            status: integration?.installationStatus,
            organizationName: integration?.organizationName,
        };
    }
}
