import { Inject } from '@nestjs/common';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    GITHUB_SERVICE_TOKEN,
    IGithubService,
} from '@libs/platform/domain/github/contracts/github.service.contract';

export class GetIntegrationGithubUseCase implements IUseCase {
    constructor(
        @Inject(GITHUB_SERVICE_TOKEN)
        private readonly githubService: IGithubService,
    ) {}

    public async execute(installId) {
        const integration =
            await this.githubService.findOneByInstallId(installId);

        // Public endpoint: the status only. The organization name would let
        // anyone map installation ids to the GitHub organizations behind them.
        return { status: integration?.installationStatus };
    }
}
