import {
    BadRequestException,
    ForbiddenException,
    Inject,
    Injectable,
    NotFoundException,
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
    CUSTOM_AGENT_TRY_RUN_STORE_TOKEN,
    CUSTOM_AGENT_TRY_RUNNER_TOKEN,
    type CustomAgentTryRun,
    type CustomAgentTryTrace,
    type ICustomAgentTryRunner,
    type ICustomAgentTryRunStore,
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
import { createLogger } from '@libs/core/log/logger';

import { loadCodeReviewConfigValue } from './custom-agent-context';
import { validateDraftAgent } from './resolve-custom-agent.use-case';

const logger = createLogger('TryCustomAgentUseCase');

/**
 * A run still marked running after this long lost its process (a deploy or
 * a crash): the poll reports it failed instead of spinning forever.
 */
export const TRY_RUN_STALE_MS = 45 * 60 * 1000;

type TryParams = {
    organizationAndTeamData: OrganizationAndTeamData;
    repositoryId: string;
    /** Set when the agent is tried from a directory's settings. */
    directoryId?: string;
    prUrl: string;
    agent: unknown;
    knowledge?: KnowledgeItem[];
};

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
        @Optional()
        @Inject(CUSTOM_AGENT_TRY_RUN_STORE_TOKEN)
        private readonly runStore?: ICustomAgentTryRunStore,
    ) {}

    /** Runs the agent and waits for its trace. */
    async execute(params: TryParams): Promise<CustomAgentTryTrace> {
        const prepared = await this.prepare(params);
        return this.runner.runCustomAgentOnPullRequest(prepared);
    }

    /**
     * Starts the run and returns its id at once; the trace is stored when
     * the run ends and read back with `getRun`. A large pull request takes
     * longer than a proxied request may stay open.
     */
    async start(
        params: TryParams,
    ): Promise<{ runId: string; status: 'running' }> {
        const prepared = await this.prepare(params);
        if (!this.runStore) {
            throw new ServiceUnavailableException(
                'Try it is not available on this server yet',
            );
        }
        const { organizationAndTeamData } = params;
        const runId = await this.runStore.create({
            organizationId: organizationAndTeamData.organizationId,
            teamId: organizationAndTeamData.teamId,
            repositoryId: params.repositoryId,
            status: 'running',
            startedAt: new Date(),
        });
        const startedAt = Date.now();
        void this.runner
            .runCustomAgentOnPullRequest(prepared)
            .catch((error): CustomAgentTryTrace => ({
                status: 'failed',
                reason: error instanceof Error ? error.message : String(error),
                skillsOpened: [],
                toolCalls: [],
                findings: [],
                durationMs: Date.now() - startedAt,
            }))
            .then((trace) => this.runStore.finish(runId, trace))
            .catch((error) =>
                logger.error({
                    message: 'Could not store the Try it result',
                    context: TryCustomAgentUseCase.name,
                    error,
                    metadata: {
                        runId,
                        organizationId: organizationAndTeamData.organizationId,
                        teamId: organizationAndTeamData.teamId,
                        repositoryId: params.repositoryId,
                    },
                }),
            );
        return { runId, status: 'running' };
    }

    /** A started run, as the settings page polls it. */
    async getRun(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        runId: string;
        now?: Date;
    }): Promise<{
        runId: string;
        status: 'running' | 'done';
        result?: CustomAgentTryTrace;
    }> {
        await this.assertPlan(params.organizationAndTeamData);
        if (!this.runStore) {
            throw new ServiceUnavailableException(
                'Try it is not available on this server yet',
            );
        }
        const run = await this.runStore.find(params.runId);
        // Another tenant's, team's or repository's run reads as missing.
        if (
            !run ||
            run.organizationId !==
                params.organizationAndTeamData.organizationId ||
            run.teamId !== params.organizationAndTeamData.teamId ||
            run.repositoryId !== params.repositoryId
        ) {
            throw new NotFoundException('Try it run not found');
        }
        return toRunView(run, params.now ?? new Date());
    }

    private async assertPlan(organizationAndTeamData: OrganizationAndTeamData) {
        // A try runs the agent as a review would: same plan as the review.
        if (
            !(await isCustomAgentsPlanAllowed(
                this.licenseService,
                organizationAndTeamData,
                TryCustomAgentUseCase.name,
            ))
        ) {
            throw new ForbiddenException(CUSTOM_AGENTS_PLAN_REQUIRED);
        }
    }

    private async prepare(
        params: TryParams,
    ): Promise<
        Parameters<ICustomAgentTryRunner['runCustomAgentOnPullRequest']>[0]
    > {
        await this.assertPlan(params.organizationAndTeamData);
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

        return {
            organizationAndTeamData: params.organizationAndTeamData,
            repositoryId: params.repositoryId,
            prUrl: params.prUrl,
            agent,
            knowledge,
        };
    }
}

function toRunView(
    run: CustomAgentTryRun,
    now: Date,
): { runId: string; status: 'running' | 'done'; result?: CustomAgentTryTrace } {
    if (run.status === 'done' && run.result) {
        return { runId: run.id, status: 'done', result: run.result };
    }
    if (now.getTime() - new Date(run.startedAt).getTime() > TRY_RUN_STALE_MS) {
        return {
            runId: run.id,
            status: 'done',
            result: {
                status: 'failed',
                reason: 'The run was interrupted before it finished. Try again.',
                skillsOpened: [],
                toolCalls: [],
                findings: [],
            },
        };
    }
    return { runId: run.id, status: 'running' };
}
