import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import { ParametersKey } from '@libs/core/domain/enums';
import { createLogger } from '@libs/core/log/logger';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';

export type CodeReviewScope = {
    id: string;
    name: string;
    isSelected: boolean;
    directories: Array<{ id: string; name: string; paths: string[] }>;
};

/**
 * The settings scopes a team can switch between — repositories and their
 * configured directories — as names and ids only.
 *
 * `/code-review-parameter` answers the same question but returns every
 * scope's full merged configuration and, by default, overlays each
 * repository's `kodus-config.yml` live from the git provider. That is the
 * right payload for the settings screen and much too heavy for a picker: an
 * organization with dozens of repositories pays megabytes and a round of
 * provider calls to render a list of names.
 */
@Injectable()
export class GetCodeReviewScopesUseCase {
    private readonly logger = createLogger(GetCodeReviewScopesUseCase.name);

    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        private readonly authorizationService: AuthorizationService,
    ) {}

    async execute(
        user: Partial<IUser>,
        teamId: string,
    ): Promise<CodeReviewScope[]> {
        try {
            const organizationId = user?.organization?.uuid;

            // A missing organization or teamId is a bad request, not a
            // server fault: thrown as plain Errors these surfaced as 500s and
            // paged on a caller that simply forgot a query param.
            if (!organizationId) {
                throw new BadRequestException(
                    'User organization data is missing',
                );
            }

            if (!teamId) {
                throw new BadRequestException('Team ID is required');
            }

            const parametersEntity = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                { organizationId, teamId },
            );

            const repositories =
                parametersEntity?.toObject()?.configValue?.repositories ?? [];

            const scopes: CodeReviewScope[] = [];

            for (const repository of repositories) {
                const allowed = await this.authorizationService.check({
                    user,
                    action: Action.Read,
                    resource: ResourceType.CodeReviewSettings,
                    repoIds: [repository.id],
                });

                if (!allowed) {
                    continue;
                }

                scopes.push({
                    id: repository.id,
                    name: repository.name,
                    isSelected: Boolean(repository.isSelected),
                    directories: (repository.directories ?? []).map(
                        (directory) => ({
                            id: directory.id,
                            name: directory.name,
                            paths: (directory.folders ?? []).map(
                                (folder) => folder.path,
                            ),
                        }),
                    ),
                });
            }

            return scopes;
        } catch (error) {
            // A bad request is the caller's mistake — rethrow it as-is instead
            // of logging it as a server error and turning it into noise.
            if (error instanceof BadRequestException) {
                throw error;
            }

            this.logger.error({
                message: 'Error listing code review scopes',
                context: GetCodeReviewScopesUseCase.name,
                error,
                metadata: { teamId },
            });
            throw error;
        }
    }
}
