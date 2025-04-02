import {
    IJiraService,
    JIRA_SERVICE_TOKEN,
} from '@/core/domain/jira/contracts/jira.service.contract';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

export class GetUsersInBoardByNameUseCase implements IUseCase {
    constructor(
        @Inject(JIRA_SERVICE_TOKEN)
        private readonly jiraService: IJiraService,

        @Inject(REQUEST)
        private readonly request: Request & { user },
    ) {}

    async execute() {
        return await this.jiraService.getProjectUsers(
            this.request.user?.organization?.uuid,
        );
    }
}
