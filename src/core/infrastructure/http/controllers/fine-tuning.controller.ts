import { Controller, Post, Body, Param, UseGuards } from '@nestjs/common';
import { UpdateFineTuningToggleUseCase } from '@/core/application/use-cases/parameters/update-fine-tuning-toggle.use-case';
import { UpdateGlobalFineTuningConfigUseCase } from '@/core/application/use-cases/global-parameters/update-global-fine-tuning-config.use-case';
import { PolicyGuard } from '@/core/infrastructure/adapters/services/permissions/policy.guard';
import { checkRepoPermissions, checkPermissions } from '@/core/infrastructure/adapters/services/permissions/policy.handlers';
import { Action, ResourceType } from '@/core/domain/permissions/enums/permissions.enum';
import { REQUEST } from '@nestjs/core';
import { Inject } from '@nestjs/common';
import { Request } from 'express';

export class UpdateFineTuningToggleDto {
    fineTuningEnabled: boolean;
}

export class UpdateGlobalFineTuningConfigDto {
    enabled: boolean;
}

@Controller('fine-tuning')
export class FineTuningController {
    constructor(
        private readonly updateFineTuningToggleUseCase: UpdateFineTuningToggleUseCase,
        private readonly updateGlobalFineTuningConfigUseCase: UpdateGlobalFineTuningConfigUseCase,
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { uuid: string; organization: { uuid: string } };
        },
    ) {}

    @Post('repository/:repositoryId/toggle')
    @UseGuards(
        PolicyGuard(
            checkRepoPermissions(Action.Update, ResourceType.CodeReviewSettings, {
                key: { params: 'repositoryId' },
            }),
        ),
    )
    async updateRepositoryToggle(
        @Param('repositoryId') repositoryId: string,
        @Body() body: UpdateFineTuningToggleDto,
    ) {
        if (!this.request.user?.uuid) {
            throw new Error('User not authenticated');
        }

        const organizationAndTeamData = {
            organizationId: this.request.user.organization.uuid,
            teamId: this.request.user.organization.uuid, // Assuming teamId is same as organizationId for now
        };

        return this.updateFineTuningToggleUseCase.execute({
            user: this.request.user,
            organizationAndTeamData,
            repositoryId,
            fineTuningEnabled: body.fineTuningEnabled,
        });
    }

    @Post('global/config')
    @UseGuards(
        PolicyGuard(
            checkPermissions(Action.Manage, ResourceType.OrganizationSettings),
        ),
    )
    async updateGlobalConfig(@Body() body: UpdateGlobalFineTuningConfigDto) {
        if (!this.request.user?.uuid) {
            throw new Error('User not authenticated');
        }

        const organizationAndTeamData = {
            organizationId: this.request.user.organization.uuid,
            teamId: this.request.user.organization.uuid, // Assuming teamId is same as organizationId for now
        };

        return this.updateGlobalFineTuningConfigUseCase.execute({
            user: this.request.user,
            organizationAndTeamData,
            enabled: body.enabled,
        });
    }
}
