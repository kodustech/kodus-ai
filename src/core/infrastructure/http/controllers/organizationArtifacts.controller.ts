import { ExecuteOrganizationArtifactsUseCase } from '@/core/application/use-cases/organizationArtifacts/execute-organization-artifacts.use-case';
import { Body, Controller, Get, Patch, Post, Put } from '@nestjs/common';
import { TeamQueryDto } from '../dtos/teamId-query-dto';
import { GetOrganizationArtifactsUseCase } from '@/core/application/use-cases/organizationArtifacts/get-organization-artifacts.use-case';
import { DismissOrganizationArtifactsUseCase } from '@/core/application/use-cases/organizationArtifacts/dismiss-organization-artifacts.use-case';

@Controller('organization-artifacts')
export class OrganizationArtifactsController {
    constructor(
        private readonly executeOrganizationArtifactsUseCase: ExecuteOrganizationArtifactsUseCase,
        private readonly getOrganizationArtifactsUseCase: GetOrganizationArtifactsUseCase,
        private readonly dismissOrganizationArtifactsUseCase: DismissOrganizationArtifactsUseCase,
    ) {}

    @Post('/run')
    public async runTeamArtifacts(
        @Body()
        body: {
            organizationId: string;
            type: string;
        },
    ) {
        return await this.executeOrganizationArtifactsUseCase.execute(body);
    }

    @Get('/')
    public async getOrganizationArtifacts(@Body() body: { teamId: string }) {
        return await this.getOrganizationArtifactsUseCase.execute(body?.teamId);
    }

    @Patch('/dismiss')
    public async dismissOrganizationArtifacts(
        @Body() body: { artifactId: string; teamId: string },
    ) {
        return await this.dismissOrganizationArtifactsUseCase.execute(
            body?.artifactId,
            body?.teamId,
        );
    }
}
