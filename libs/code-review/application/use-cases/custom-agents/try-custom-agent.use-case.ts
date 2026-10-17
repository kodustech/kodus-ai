import {
    BadRequestException,
    Inject,
    Injectable,
    Optional,
    ServiceUnavailableException,
} from '@nestjs/common';

import { encrypt } from '@libs/common/utils/crypto';
import {
    CliSecretMissingError,
    effectiveStoredCustomAgents,
    sealCustomAgentSecrets,
} from '@libs/code-review/domain/custom-agents/cli-secrets';
import {
    CUSTOM_AGENT_TRY_RUNNER_TOKEN,
    type CustomAgentTryTrace,
    type ICustomAgentTryRunner,
} from '@libs/code-review/domain/custom-agents/contracts';
import {
    type CustomAgentConfig,
    customAgentConfigSchema,
    type KnowledgeItem,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
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
        @Optional()
        @Inject(CUSTOM_AGENT_TRY_RUNNER_TOKEN)
        private readonly runner?: ICustomAgentTryRunner,
    ) {}

    async execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        prUrl: string;
        agent: unknown;
        knowledge?: KnowledgeItem[];
    }): Promise<CustomAgentTryTrace> {
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
        // Only the agents this repository would run can lend a kept secret.
        let sealed: CustomAgentConfig;
        try {
            [sealed] = sealCustomAgentSecrets(
                [params.agent as CustomAgentConfig],
                effectiveStoredCustomAgents(configValue, {
                    repositoryId: params.repositoryId,
                }),
                encrypt,
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
