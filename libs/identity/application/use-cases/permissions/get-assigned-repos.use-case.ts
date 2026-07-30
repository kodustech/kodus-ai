import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    IPermissionsService,
    PERMISSIONS_SERVICE_TOKEN,
} from '@libs/identity/domain/permissions/contracts/permissions.service.contract';

@Injectable()
export class GetAssignedReposUseCase implements IUseCase {
    private readonly logger = createLogger(GetAssignedReposUseCase.name);
    constructor(
        @Inject(PERMISSIONS_SERVICE_TOKEN)
        private readonly permissionsService: IPermissionsService,
    ) {}

    async execute(params: { userId: string }): Promise<string[]> {
        const { userId } = params;

        if (!userId) {
            this.logger.warn({
                message: 'User UUID is missing',
                metadata: { params },
                context: GetAssignedReposUseCase.name,
            });

            return [];
        }

        try {
            const permissions = await this.permissionsService.findOne({
                user: { uuid: userId },
            });

            if (!permissions) {
                this.logger.warn({
                    message: `No permissions found for user with UUID: ${userId}`,
                    context: GetAssignedReposUseCase.name,
                });
                return [];
            }

            return permissions.permissions?.assignedRepositoryIds || [];
        } catch (error) {
            this.logger.error({
                message: 'Error getting assigned repositories',
                error,
                context: GetAssignedReposUseCase.name,
                metadata: { params },
            });

            throw error;
        }
    }
}
