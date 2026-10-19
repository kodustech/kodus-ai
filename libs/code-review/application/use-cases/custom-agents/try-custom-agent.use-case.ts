import {
    BadRequestException,
    ForbiddenException,
    Inject,
    Injectable,
    Optional,
    ServiceUnavailableException,
} from '@nestjs/common';

import { encryptCliSecret } from '@libs/code-review/domain/custom-agents/cli-secret-cipher';
import {
    CliSecretMissingError,
    sealCustomAgentSecrets,
    storedCustomAgentsForTry,
} from '@libs/code-review/domain/custom-agents/cli-secrets';
import {
    CUSTOM_AGENT_TRY_RUNNER_TOKEN,
    type CustomAgentTryTrace,
    type ICustomAgentTryRunner,
} from '@libs/code-review/domain/custom-agents/contracts';
import {
    CUSTOM_AGENTS_PLAN_REQUIRED,
    isCustomAgentsPlanAllowed,
} from '@libs/code-review/infrastructure/agents/custom-agents/custom-agents-plan';
import {
    type CustomAgentConfig,
    customAgentConfigSchema,
    type KnowledgeItem,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    type ILicenseService,
    LICENSE_SERVICE_TOKEN,
} from '@libs/ee/license/interfaces/license.interface';
import {
    type IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';

import { loadCodeReviewConfigValue } from './custom-agent-context';
import { validateDraftAgent } from './resolve-custom-agent.use-case';

/**
 * Runs one agent, saved or not, on a pull request without posting, and
 * returns what it did: skills opened, tool calls, findings and verdicts.
 */
@Injectable()
export class TryCustomAgentUseCase {
    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService: ILicenseService,
        @Optional()
        @Inject(CUSTOM_AGENT_TRY_RUNNER_TOKEN)
        private readonly runner?: ICustomAgentTryRunner,
    ) {}

    async execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        /** Set when the agent is tried from a directory's settings. */
        directoryId?: string;
        prUrl: string;
        agent: unknown;
        knowledge?: KnowledgeItem[];
    }): Promise<CustomAgentTryTrace> {
        // A try runs the agent as a review would: same plan as the review.
        if (
            !(await isCustomAgentsPlanAllowed(
                this.licenseService,
                params.organizationAndTeamData,
                TryCustomAgentUseCase.name,
            ))
        ) {
            throw new ForbiddenException(CUSTOM_AGENTS_PLAN_REQUIRED);
        }
        if (!/^https?:\/\/\S+$/i.test(params.prUrl ?? '')) {
            throw new BadRequestException('prUrl must be a pull request URL');
        }
        const issues = validateDraftAgent(params.agent);
        if (issues.length) {
            throw new BadRequestException(issues);
        }
        if (!this.runner) {
            throw new ServiceUnavailableException(
                'Try it is not available on this server yet',
            );
        }

        // A draft carries typed or masked secrets; the run needs them as a
        // stored agent would have them, so seal them the way a save does.
        const configValue = await loadCodeReviewConfigValue(
            this.parametersService,
            params.organizationAndTeamData,
        );
        // Only the level the caller edits can lend a kept secret, as on a
        // save: never the global config a repository inherits.
        let sealed: CustomAgentConfig;
        try {
            [sealed] = sealCustomAgentSecrets(
                [params.agent as CustomAgentConfig],
                storedCustomAgentsForTry(configValue, {
                    repositoryId: params.repositoryId,
                    directoryId: params.directoryId,
                }),
                encryptCliSecret,
            );
        } catch (error) {
            if (error instanceof CliSecretMissingError) {
                throw new BadRequestException(error.message);
            }
            throw error;
        }
        const agent = customAgentConfigSchema.parse(sealed);

        const knowledge = (params.knowledge ?? []).filter((item) =>
            item.linkedTo?.some(
                (target) =>
                    typeof target === 'object' && target.agentId === agent.id,
            ),
        );

        return this.runner.runCustomAgentOnPullRequest({
            organizationAndTeamData: params.organizationAndTeamData,
            repositoryId: params.repositoryId,
            prUrl: params.prUrl,
            agent,
            knowledge,
        });
    }
}
