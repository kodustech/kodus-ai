import { ColumnsConfigKey } from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import {
    IJiraService,
    JIRA_SERVICE_TOKEN,
} from '@/core/domain/jira/contracts/jira.service.contract';

import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

export class CreateOrUpdateColumnsBoardUseCase implements IUseCase {
    constructor(
        @Inject(JIRA_SERVICE_TOKEN)
        private readonly jiraService: IJiraService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(params: {
        columns: ColumnsConfigKey[];
        teamId: any;
    }) {
        return this.jiraService.createOrUpdateColumns({
            columns: params.columns,
            organizationId: this.request.user?.organization?.uuid,
            teamId: params.teamId,
        });
    }
}
