import { createLogger, createThreadId } from '@kodus/flow';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { BusinessRulesValidationAgentProvider } from '@libs/agents/infrastructure/services/kodus-flow/business-rules-validation/businessRulesValidationAgent';
import { BusinessRulesPrepareContext } from '@libs/agents/infrastructure/services/kodus-flow/business-rules-validation/types';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { PullRequest } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

interface TriggerBusinessValidationInput {
    prUrl?: string;
    prNumber?: number;
    repositoryId?: string;
    repository?: string;
    taskUrl?: string;
    taskId?: string;
    diff?: string;
}

type BusinessValidationMode = 'pull_request' | 'local_diff';

export interface TriggerBusinessValidationResult {
    accepted: boolean;
    mode: BusinessValidationMode;
    command: string;
    prNumber?: number;
    prUrl?: string;
    repositoryId?: string;
    repositoryName?: string;
    taskReference?: string;
    result: string;
}

interface BusinessValidationRepositoryContext {
    id: string;
    name: string;
    owner?: string;
    defaultBranch?: string;
}

interface BaseBusinessValidationExecutionContext {
    pullRequestDescription: string;
    repository?: BusinessValidationRepositoryContext;
    prDiff?: string;
    headRef?: string;
    baseRef?: string;
}

interface PullRequestValidationExecutionContext extends BaseBusinessValidationExecutionContext {
    mode: 'pull_request';
    repository: BusinessValidationRepositoryContext;
    prNumber: number;
    prUrl: string;
}

interface LocalDiffValidationExecutionContext extends BaseBusinessValidationExecutionContext {
    mode: 'local_diff';
    prDiff: string;
}

@Injectable()
export class TriggerBusinessValidationUseCase implements IUseCase {
    private readonly logger = createLogger(
        TriggerBusinessValidationUseCase.name,
    );
    private static readonly MAX_SIGNAL_SOURCE_LENGTH = 20_000;
    private static readonly REQUIREMENT_KEYWORDS = [
        'requirement',
        'acceptance criteria',
        'user story',
        'given',
        'when',
        'then',
    ];

    constructor(
        private readonly codeManagementService: CodeManagementService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        private readonly businessRulesValidationAgentProvider: BusinessRulesValidationAgentProvider,
    ) {}

    async execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        input: TriggerBusinessValidationInput;
    }): Promise<TriggerBusinessValidationResult> {
        const { organizationAndTeamData, input } = params;
        const mode = this.resolveMode(input);
        const taskReference = input.taskUrl?.trim() || input.taskId?.trim();
        const command = this.buildBusinessValidationCommand(taskReference);
        const platformType =
            await this.codeManagementService.getTypeIntegration(
                organizationAndTeamData,
            );

        const executionContext =
            mode === 'pull_request'
                ? await this.resolvePullRequestContext({
                      organizationAndTeamData,
                      input,
                  })
                : await this.resolveLocalDiffContext({
                      organizationAndTeamData,
                      input,
                      taskReference,
                  });

        const prepareContext = this.buildPrepareContext({
            command,
            taskReference,
            taskId: input.taskId,
            taskUrl: input.taskUrl,
            platformType,
            executionContext,
        });

        const result = await this.businessRulesValidationAgentProvider.execute({
            organizationAndTeamData,
            thread: this.createThread({
                organizationAndTeamData,
                context: executionContext,
            }),
            prepareContext,
        });

        if (executionContext.mode === 'pull_request') {
            return {
                accepted: true,
                mode: executionContext.mode,
                command,
                prNumber: executionContext.prNumber,
                prUrl: executionContext.prUrl,
                repositoryId: executionContext.repository.id,
                repositoryName: executionContext.repository.name,
                taskReference,
                result,
            };
        }

        return {
            accepted: true,
            mode: executionContext.mode,
            command,
            repositoryId: executionContext.repository?.id,
            repositoryName: executionContext.repository?.name,
            taskReference,
            result,
        };
    }

    private resolveMode(
        input: TriggerBusinessValidationInput,
    ): BusinessValidationMode {
        const hasPrUrl = !!input.prUrl?.trim();
        const hasPrNumber = typeof input.prNumber === 'number';
        const hasDiff = !!input.diff?.trim();

        if (hasPrUrl && hasPrNumber) {
            throw new BadRequestException(
                'Use either prUrl or prNumber (not both).',
            );
        }

        if (
            hasPrNumber &&
            !input.repositoryId?.trim() &&
            !input.repository?.trim()
        ) {
            throw new BadRequestException(
                'repositoryId or repository is required when prNumber is provided.',
            );
        }

        if (input.taskUrl && input.taskId) {
            throw new BadRequestException(
                'Provide either taskUrl or taskId (not both).',
            );
        }

        if ((hasPrUrl || hasPrNumber) && hasDiff) {
            throw new BadRequestException(
                'Use either pull request context (prUrl/prNumber) or diff (not both).',
            );
        }

        if (hasPrUrl || hasPrNumber) {
            return 'pull_request';
        }

        if (hasDiff) {
            return 'local_diff';
        }

        throw new BadRequestException(
            'Provide either pull request context (prUrl/prNumber) or diff.',
        );
    }

    private buildBusinessValidationCommand(taskReference?: string): string {
        return taskReference
            ? `@kody -v business-logic ${taskReference}`
            : '@kody -v business-logic';
    }

    private async resolvePullRequestContext(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        input: TriggerBusinessValidationInput;
    }): Promise<PullRequestValidationExecutionContext> {
        const { organizationAndTeamData, input } = params;

        if (input.prUrl?.trim()) {
            const requestedUrl = input.prUrl.trim();
            const pullRequests =
                await this.codeManagementService.getPullRequests({
                    organizationAndTeamData,
                    filters: { url: requestedUrl },
                });

            const selectedPr = this.findBestPrByUrl(pullRequests, requestedUrl);
            if (!selectedPr) {
                throw new BadRequestException(
                    `Pull request not found for URL: ${requestedUrl}`,
                );
            }

            return this.mapPullRequestContext(selectedPr, requestedUrl);
        }

        const requestedPrNumber = Number(input.prNumber);
        const repository = await this.resolveRepository({
            organizationAndTeamData,
            repositoryId: input.repositoryId,
            repositoryName: input.repository,
        });

        if (!repository) {
            throw new BadRequestException(
                `Repository not found for filter: ${input.repositoryId || input.repository}`,
            );
        }

        const pullRequests = await this.codeManagementService.getPullRequests({
            organizationAndTeamData,
            repository: {
                id: repository.id,
                name: repository.name,
            },
            filters: { number: requestedPrNumber },
        });

        const selectedPr = pullRequests?.find(
            (pr) => Number(pr.number || pr.pull_number) === requestedPrNumber,
        );

        if (!selectedPr) {
            throw new BadRequestException(
                `Pull request #${requestedPrNumber} not found in repository ${repository.name}.`,
            );
        }

        return this.mapPullRequestContext(selectedPr, selectedPr.prURL || '', {
            id: repository.id,
            name: repository.name,
            owner: repository.owner,
        });
    }

    private mapPullRequestContext(
        pr: PullRequest,
        fallbackUrl: string,
        fallbackRepository?: BusinessValidationRepositoryContext,
    ): PullRequestValidationExecutionContext {
        const repositoryId =
            String(pr.repositoryData?.id || pr.repositoryId || '').trim() ||
            fallbackRepository?.id;
        const repositoryName =
            pr.repositoryData?.name ||
            pr.repository ||
            fallbackRepository?.name;
        const repositoryOwner =
            this.extractRepositoryOwnerFromFullName(
                pr.head?.repo?.fullName,
                pr.head?.repo?.name,
            ) ||
            this.extractRepositoryOwnerFromFullName(
                pr.base?.repo?.fullName,
                pr.base?.repo?.name,
            ) ||
            this.extractRepositoryOwnerFromFullName(
                pr.repository,
                repositoryName,
            ) ||
            fallbackRepository?.owner;

        if (!repositoryId || !repositoryName) {
            throw new BadRequestException(
                'Repository data not found for the selected pull request.',
            );
        }

        return {
            mode: 'pull_request',
            prNumber: Number(pr.number || pr.pull_number),
            prUrl: pr.prURL || fallbackUrl,
            repository: {
                id: repositoryId,
                name: repositoryName,
                owner: repositoryOwner,
                defaultBranch: pr.base?.repo?.defaultBranch || pr.base?.ref,
            },
            pullRequestDescription: pr.body || pr.message || '',
            headRef: pr.head?.ref,
            baseRef: pr.base?.ref,
        };
    }

    private findBestPrByUrl(
        pullRequests: PullRequest[] = [],
        requestedUrl: string,
    ): PullRequest | undefined {
        if (!pullRequests.length) {
            return undefined;
        }

        const normalizedRequestedUrl = this.normalizeUrl(requestedUrl);
        return (
            pullRequests.find(
                (pr) => this.normalizeUrl(pr.prURL) === normalizedRequestedUrl,
            ) || pullRequests[0]
        );
    }

    private normalizeUrl(url?: string): string {
        let normalized = (url || '').trim().toLowerCase();
        while (normalized.endsWith('/')) {
            normalized = normalized.slice(0, -1);
        }
        return normalized;
    }

    private async resolveRepository(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId?: string;
        repositoryName?: string;
    }): Promise<BusinessValidationRepositoryContext | undefined> {
        const { organizationAndTeamData, repositoryId, repositoryName } =
            params;

        const normalizedId = repositoryId ? repositoryId.trim() : undefined;
        const normalizedName = repositoryName
            ? repositoryName.trim().toLowerCase()
            : undefined;

        if (!normalizedId && !normalizedName) {
            return undefined;
        }

        const repositories =
            await this.integrationConfigService.findIntegrationConfigFormatted<
                Repositories[]
            >(IntegrationConfigKey.REPOSITORIES, organizationAndTeamData);

        if (!repositories?.length) {
            return undefined;
        }

        const match = repositories.find((repo) => {
            if (normalizedId && String(repo.id) === normalizedId) {
                return true;
            }

            if (!normalizedName) {
                return false;
            }

            const candidates = [
                repo.name,
                (repo as { fullName?: string }).fullName,
                (repo as { full_name?: string }).full_name,
                repo.organizationName
                    ? `${repo.organizationName}/${repo.name}`
                    : undefined,
            ].filter(Boolean) as string[];

            return candidates.some(
                (candidate) => candidate.toLowerCase() === normalizedName,
            );
        });

        if (!match) {
            return undefined;
        }

        return {
            id: String(match.id),
            name: match.name,
            owner:
                match.organizationName ||
                this.extractRepositoryOwnerFromFullName(
                    match.full_name || match.name,
                    match.name,
                ),
            defaultBranch:
                (match as { defaultBranch?: string }).defaultBranch ||
                (match as { default_branch?: string }).default_branch,
        };
    }

    private async resolveLocalDiffContext(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        input: TriggerBusinessValidationInput;
        taskReference?: string;
    }): Promise<LocalDiffValidationExecutionContext> {
        const { organizationAndTeamData, input, taskReference } = params;
        const prDiff = this.normalizeDiff(input.diff);

        if (!prDiff) {
            throw new BadRequestException(
                'diff is required when no pull request context is provided.',
            );
        }

        const resolvedRepository = await this.resolveRepository({
            organizationAndTeamData,
            repositoryId: input.repositoryId,
            repositoryName: input.repository,
        });

        const repository =
            resolvedRepository || this.buildRepositoryHintFromInput(input);

        return {
            mode: 'local_diff',
            repository,
            prDiff,
            pullRequestDescription:
                this.buildLocalDiffDescription(taskReference),
        };
    }

    private buildRepositoryHintFromInput(
        input: TriggerBusinessValidationInput,
    ): BusinessValidationRepositoryContext | undefined {
        const repositoryId = input.repositoryId?.trim();
        const repositoryName = input.repository?.trim();
        const inferredOwner = this.extractRepositoryOwnerFromFullName(
            repositoryName,
            repositoryName,
        );

        if (!repositoryId && !repositoryName) {
            return undefined;
        }

        return {
            id: repositoryId || repositoryName,
            name: repositoryName?.includes('/')
                ? repositoryName.split('/').pop() || repositoryName
                : repositoryName || repositoryId,
            owner: inferredOwner,
        };
    }

    private buildLocalDiffDescription(taskReference?: string): string {
        if (taskReference) {
            return `Local diff validation requested for task: ${taskReference}`;
        }

        return 'Local diff validation requested from CLI.';
    }

    private normalizeDiff(diff?: string): string {
        if (typeof diff !== 'string') {
            return '';
        }

        return diff.trim().length > 0 ? diff : '';
    }

    private extractRepositoryOwnerFromFullName(
        fullName?: string,
        repositoryName?: string,
    ): string | undefined {
        if (typeof fullName !== 'string' || !fullName.trim().length) {
            return undefined;
        }

        const normalized = fullName.trim();
        const segments = normalized.split('/').filter(Boolean);
        if (segments.length < 2) {
            return undefined;
        }

        const owner = segments[0].trim();
        const tail = segments[segments.length - 1].trim();

        if (!owner.length || !tail.length) {
            return undefined;
        }

        if (
            typeof repositoryName === 'string' &&
            repositoryName.trim().length > 0
        ) {
            const normalizedRepositoryName = repositoryName
                .trim()
                .split('/')
                .pop();

            if (
                normalizedRepositoryName &&
                tail.toLowerCase() !== normalizedRepositoryName.toLowerCase()
            ) {
                return undefined;
            }
        }

        return owner;
    }

    private buildPrepareContext(params: {
        command: string;
        taskReference?: string;
        taskId?: string;
        taskUrl?: string;
        platformType?: string;
        executionContext:
            | PullRequestValidationExecutionContext
            | LocalDiffValidationExecutionContext;
    }): BusinessRulesPrepareContext {
        const {
            command,
            taskReference,
            taskId,
            taskUrl,
            platformType,
            executionContext,
        } = params;
        const prepareContext: BusinessRulesPrepareContext = {
            userQuestion: command,
            taskReference: taskReference || undefined,
            taskId: taskId?.trim() || undefined,
            taskUrl: taskUrl?.trim() || undefined,
            pullRequestDescription: executionContext.pullRequestDescription,
            platformType: platformType || undefined,
            businessSignals: this.detectSignals(
                executionContext.pullRequestDescription,
                taskReference,
                executionContext.prDiff,
                taskId,
                taskUrl,
            ),
        };

        if (executionContext.repository) {
            prepareContext.repository = {
                id: executionContext.repository.id,
                name: executionContext.repository.name,
                owner: executionContext.repository.owner,
                defaultBranch: executionContext.repository.defaultBranch,
            };
            prepareContext.defaultBranch =
                executionContext.repository.defaultBranch ||
                executionContext.baseRef;
        }

        if (executionContext.prDiff) {
            prepareContext.prDiff = executionContext.prDiff;
        }

        if (executionContext.mode === 'pull_request') {
            prepareContext.pullRequest = {
                pullRequestNumber: executionContext.prNumber,
                headRef: executionContext.headRef,
                baseRef: executionContext.baseRef,
            };
            prepareContext.pullRequestNumber = executionContext.prNumber;
            prepareContext.headRef = executionContext.headRef;
            prepareContext.baseRef = executionContext.baseRef;
        }

        return prepareContext;
    }

    private detectSignals(
        pullRequestDescription: string,
        taskReference?: string,
        prDiff?: string,
        taskId?: string,
        taskUrl?: string,
    ): Record<string, string[]> {
        const normalizedTaskId = taskId?.trim();
        const normalizedTaskUrl = taskUrl?.trim();
        const prDiffSignal =
            typeof prDiff === 'string' && prDiff.length > 0
                ? prDiff.slice(
                      0,
                      TriggerBusinessValidationUseCase.MAX_SIGNAL_SOURCE_LENGTH,
                  )
                : undefined;
        const referenceSource = [taskReference, pullRequestDescription]
            .filter(Boolean)
            .join('\n');
        const ticketSource = [referenceSource, prDiffSignal, normalizedTaskId]
            .filter(Boolean)
            .join('\n');
        const taskLinkSource = [normalizedTaskUrl, referenceSource]
            .filter(Boolean)
            .join('\n');
        const keywordSource = [referenceSource, prDiffSignal]
            .filter(Boolean)
            .join('\n');

        const ticketKeys = [
            ...(normalizedTaskId ? [normalizedTaskId] : []),
            ...this.detectTicketKeys(ticketSource),
        ];
        const taskLinks = [
            ...(normalizedTaskUrl ? [normalizedTaskUrl] : []),
            ...this.detectTaskLinks(taskLinkSource),
        ];

        return {
            ticketKeys: [...new Set(ticketKeys)],
            taskLinks: [...new Set(taskLinks)],
            requirementKeywords: this.detectRequirementKeywords(keywordSource),
        };
    }

    private detectTicketKeys(content: string): string[] {
        const matches = content.match(/[A-Z]{2,}-\d+/g);
        return [...new Set(matches ?? [])];
    }

    private detectTaskLinks(content: string): string[] {
        const matches = content.match(/https?:\/\/[^\s)>\]"']+/g);
        return [...new Set(matches ?? [])];
    }

    private detectRequirementKeywords(content: string): string[] {
        const lower = content.toLowerCase();
        return TriggerBusinessValidationUseCase.REQUIREMENT_KEYWORDS.filter(
            (keyword) => lower.includes(keyword),
        );
    }

    private createThread(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        context:
            | PullRequestValidationExecutionContext
            | LocalDiffValidationExecutionContext;
    }): ReturnType<typeof createThreadId> | undefined {
        const { organizationAndTeamData, context } = params;

        try {
            const identifiers: Record<string, string | number> = {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
            };

            if (context.repository?.id) {
                identifiers.repositoryId = context.repository.id;
            }

            if (context.mode === 'pull_request') {
                identifiers.pullRequestNumber = context.prNumber;
            } else {
                identifiers.localDiffHash = this.buildDiffHash(context.prDiff);
            }

            return createThreadId(identifiers, { prefix: 'vbl' });
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to create business validation thread identifier',
                context: TriggerBusinessValidationUseCase.name,
                error,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    repositoryId: context.repository?.id,
                    mode: context.mode,
                },
            });
            return undefined;
        }
    }

    private buildDiffHash(diff: string): string {
        return createHash('sha256').update(diff).digest('hex').slice(0, 16);
    }
}
