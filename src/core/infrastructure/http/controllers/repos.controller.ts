import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { ICodeBaseConfigService, CODE_BASE_CONFIG_SERVICE_TOKEN } from '@/core/domain/codeBase/contracts/CodeBaseConfigService.contract';
import { IRepositoryManager, REPOSITORY_MANAGER_TOKEN } from '@/core/domain/repository/contracts/repository-manager.contract';

@Controller('repos')
export class ReposController {
    constructor(
        private readonly codeManagementService: CodeManagementService,
        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly codeBaseConfigService: ICodeBaseConfigService,
        @Inject(REPOSITORY_MANAGER_TOKEN)
        private readonly repositoryManager: IRepositoryManager,
        @Inject(REQUEST)
        private readonly request: Request & { user: { organization: { uuid: string } } },
    ) {}

    @Get(':repositoryId/files')
    async listFiles(
        @Param('repositoryId') repositoryId: string,
        @Query('teamId') teamId: string,
        @Query('glob') glob?: string | string[],
        @Query('branch') branch?: string,
    ) {
        const organizationId = this.request.user.organization.uuid;
        const { repositories } = await this.codeBaseConfigService.getCodeManagementConfigAndRepositories({
            organizationId,
            teamId,
        });

        const repo = repositories.find((r: any) => r.id === repositoryId);
        if (!repo) {
            throw new NotFoundException('Repository not found');
        }

        const organizationName = repo.organizationName || repo.repositoryPath?.split('/')[0];
        const branchName = branch || repo.default_branch || repo.defaultBranch || 'main';
        const fullName = repo.repositoryPath || repo.fullName || `${organizationName}/${repo.name}`;

        await this.codeManagementService.cloneRepository({
            repository: {
                id: repo.id,
                name: repo.name,
                fullName,
                defaultBranch: branchName,
            },
            organizationAndTeamData: { organizationId, teamId },
        });

        const patterns = Array.isArray(glob) ? glob : glob ? [glob] : undefined;

        const files = await this.repositoryManager.listRepositoryFiles(
            organizationId,
            repo.id,
            repo.name,
            branchName,
            patterns,
        );

        return files;
    }
}
