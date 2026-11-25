import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import {
    AGENT_INSTRUCTION_FILE_DISCOVERY_PATTERNS,
    isAgentInstructionProseFile,
} from '@libs/common/utils/kody-rules/file-patterns';
import { ParametersKey } from '@libs/core/domain/enums';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { createLogger } from '@libs/core/log/logger';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

const MAX_REPOSITORIES = 20;
const MAX_FILES_PER_REPOSITORY = 20;

export type AgentInstructionFilesByRepository = {
    repositoryId: string;
    repositoryName: string;
    files: string[];
    /** The git host could not list this repository. */
    unavailable?: true;
};

/**
 * The coding-agent instruction files (CLAUDE.md, AGENTS.md, .cursor/rules,
 * ...) on the default branch of each selected repository, so the user sees
 * what Kody would read before turning it on.
 *
 * Called only from `GET /kody-rules/agent-instruction-files`
 * (apps/api/src/controllers/kodyRules.controller.ts), during onboarding and in
 * settings; `REQUEST` is therefore safe to inject.
 */
@Injectable()
export class ListAgentInstructionFilesUseCase {
    private readonly logger = createLogger(
        ListAgentInstructionFilesUseCase.name,
    );

    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly codeManagementService: CodeManagementService,
        private readonly authorizationService: AuthorizationService,
        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    async execute(params: {
        teamId: string;
    }): Promise<AgentInstructionFilesByRepository[]> {
        const organizationAndTeamData = {
            organizationId: this.request.user?.organization?.uuid,
            teamId: params.teamId,
        };

        const config = await this.parametersService.findByKey(
            ParametersKey.CODE_REVIEW_CONFIG,
            organizationAndTeamData,
        );

        const scope = await this.authorizationService.getRepositoryScope({
            user: this.request.user,
            action: Action.Read,
            resource: ResourceType.KodyRules,
        });
        const allowed = Array.isArray(scope) ? new Set(scope) : null;

        const repositories = (config?.configValue?.repositories ?? [])
            .filter((repo) => repo?.isSelected !== false)
            .filter((repo) => !allowed || allowed.has(String(repo.id)))
            .slice(0, MAX_REPOSITORIES)
            .map((repo) => ({ id: String(repo.id), name: repo.name }));

        const listings = await Promise.allSettled(
            repositories.map((repository) =>
                this.codeManagementService.getRepositoryAllFiles({
                    organizationAndTeamData,
                    repository,
                    filters: {
                        filePatterns: [
                            ...AGENT_INSTRUCTION_FILE_DISCOVERY_PATTERNS,
                        ],
                    },
                    throwOnError: true,
                }),
            ),
        );

        return repositories.map((repository, index) => {
            const listing = listings[index];
            if (listing.status === 'rejected') {
                this.logger.warn({
                    message:
                        'Could not list coding-agent instruction files for repository',
                    context: ListAgentInstructionFilesUseCase.name,
                    error: listing.reason,
                    metadata: {
                        organizationAndTeamData,
                        repositoryId: repository.id,
                    },
                });
                return {
                    repositoryId: repository.id,
                    repositoryName: repository.name,
                    files: [],
                    unavailable: true as const,
                };
            }

            const files = (listing.value ?? [])
                .map((file) => file.path)
                .filter((path) => isAgentInstructionProseFile(path))
                .sort((a, b) => a.localeCompare(b))
                .slice(0, MAX_FILES_PER_REPOSITORY);

            return {
                repositoryId: repository.id,
                repositoryName: repository.name,
                files,
            };
        });
    }
}
