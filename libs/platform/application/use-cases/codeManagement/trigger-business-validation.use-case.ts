import { createLogger } from '@libs/core/log/logger';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import { BusinessValidationService } from '@libs/agents/business-validation/business-validation.service';
import type {
    BusinessValidationOutcome,
    BusinessValidationRequest,
    BusinessValidationResult,
    ResolutionAttempt,
    TaskReference,
} from '@libs/agents/business-validation/business-validation.types';
import {
    openPreview,
    PreviewSealError,
    sealPreview,
} from '@libs/agents/business-validation/preview-seal';
import { formatPullRequestDiff } from '@libs/agents/business-validation/pull-request-diff';
import { renderCliText } from '@libs/agents/business-validation/render';
import { repositoryForLookup } from '@libs/agents/business-validation/task-resolver';
import {
    buildRun,
    toRunTasks,
} from '@libs/agents/business-validation/runs/run-mapping';
import type { RunTask } from '@libs/agents/business-validation/runs/validation-run.model';
import { ValidationRunRepository } from '@libs/agents/business-validation/runs/validation-run.repository';
import {
    type BusinessLogicConfig,
    type BusinessLogicSettings,
    resolveBusinessLogicSettings,
} from '@libs/agents/business-validation/settings';
import {
    BusinessLogicPublisher,
    type PublishPreview,
} from '@libs/platform/application/services/business-logic-publisher.service';
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
    /** What a person or an agent reads: one line per requirement. */
    result: string;
    /** The same verdict, structured (`--json`). */
    verdict: CliBusinessVerdict;
}

/** The verdict a coding agent acts on before it opens the PR (UC-41). */
export interface CliBusinessVerdict {
    status:
        | 'compliant'
        | 'issues_found'
        | 'skipped'
        | 'task_too_thin'
        | 'task_missing'
        | 'task_required';
    passed: boolean;
    reason?: string;
    message?: string;
    tasks: RunTask[];
}

/** What a preview carries to be posted later, as it was shown. */
interface SealedPreview {
    organizationId: string;
    teamId?: string;
    repositoryId: string;
    request: BusinessValidationRequest;
    result: BusinessValidationResult;
    settings: BusinessLogicSettings;
    headSha?: string;
}

/** What "Test on a pull request" shows, step by step. */
export interface BusinessLogicTestResult {
    pullRequest: {
        number: number;
        url: string;
        title?: string;
        repositoryName: string;
    };
    /** The task references found in the PR, and where. */
    references: Array<
        Pick<TaskReference, 'raw' | 'id' | 'kind' | 'source' | 'intent'>
    >;
    /** Which tracker was asked for each reference, with which tools, and what it said. */
    attempts: ResolutionAttempt[];
    trackers: string[];
    /** The tasks as the judge read them, with the criteria taken from them. */
    tasks: Array<{
        tracker: string;
        id: string;
        title?: string;
        url?: string;
        criteria: string[];
        descriptionLength: number;
    }>;
    verdict: CliBusinessVerdict;
    comment: PublishPreview['comment'];
    /** Posts this result as shown (`postPreview`), without running it again. */
    previewToken: string;
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
    title?: string;
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

    constructor(
        private readonly codeManagementService: CodeManagementService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        private readonly businessValidationService: BusinessValidationService,
        private readonly businessLogicPublisher: BusinessLogicPublisher,
        private readonly runs: ValidationRunRepository,
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

        const config = await this.businessLogicPublisher.configFor(
            organizationAndTeamData,
            executionContext.repository?.id,
            this.pullRequestScope(executionContext, platformType),
        );
        const request = this.buildRequest({
            organizationAndTeamData,
            executionContext,
            settings: config.settings,
            config,
            platformType,
            taskInput: taskReference,
        });
        const validation = await this.businessValidationService.validate(
            this.businessLogicPublisher.withRepository(request),
        );
        // Recorded like any other door; the CLI never writes to the PR.
        await this.runs.create(buildRun(request, validation));
        const result = renderCliText(validation.outcome);
        const verdict = toCliVerdict(
            validation.outcome,
            toRunTasks(validation),
        );

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
                verdict,
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
            verdict,
        };
    }

    /**
     * "Try it" with a task alone: reads it as a validation would, with the
     * settings on screen. On a repository's page, `#12` is that repository's.
     */
    async tryReadTask(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        task: string;
        settings?: BusinessLogicConfig;
        repositoryId?: string;
    }) {
        const repository =
            params.repositoryId && params.repositoryId !== 'global'
                ? await this.resolveRepository({
                      organizationAndTeamData: params.organizationAndTeamData,
                      repositoryId: params.repositoryId,
                  }).catch((error) => {
                      this.logger.warn({
                          message:
                              'Could not resolve the repository; reading the task without it',
                          context: TriggerBusinessValidationUseCase.name,
                          error,
                          metadata: {
                              organizationId:
                                  params.organizationAndTeamData.organizationId,
                              repositoryId: params.repositoryId,
                          },
                      });
                      return undefined;
                  })
                : undefined;
        return this.businessValidationService.tryRead(
            params.organizationAndTeamData,
            params.task,
            resolveBusinessLogicSettings(params.settings),
            // As the validation reads it: GitLab stores `group/notes` as the
            // name and the group's display name as the owner.
            repository
                ? repositoryForLookup({
                      owner: repository.owner,
                      name: repository.name,
                  })
                : undefined,
        );
    }

    /**
     * "Test on a pull request" (settings page): the whole run on a real PR,
     * with the settings on screen, saved or not. Nothing is written unless
     * `post` is set; then it publishes like `@kody -v business-logic`.
     */
    async testOnPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prUrl: string;
        settings?: BusinessLogicConfig;
        taskInput?: string;
        /** Throws when the caller may not test this PR's repository. */
        authorize?: (repositoryId: string) => Promise<void>;
    }): Promise<BusinessLogicTestResult> {
        const { organizationAndTeamData } = params;
        const taskInput = params.taskInput?.trim() || undefined;
        const [platformType, executionContext] = await Promise.all([
            this.codeManagementService.getTypeIntegration(
                organizationAndTeamData,
            ),
            this.resolvePullRequestContext({
                organizationAndTeamData,
                input: { prUrl: params.prUrl },
            }),
        ]);
        await params.authorize?.(executionContext.repository.id);
        const config = await this.businessLogicPublisher.configFor(
            organizationAndTeamData,
            executionContext.repository.id,
            this.pullRequestScope(executionContext, platformType),
        );
        // The settings on screen, saved or not; the model the PR's review uses.
        const settings = params.settings
            ? resolveBusinessLogicSettings(params.settings)
            : config.settings;
        const request = this.buildRequest({
            organizationAndTeamData,
            executionContext,
            settings,
            config,
            platformType,
            taskInput,
        });
        const [validation, headSha] = await Promise.all([
            this.businessValidationService.validate(
                this.businessLogicPublisher.withRepository(request),
            ),
            this.businessLogicPublisher.headShaOf(
                organizationAndTeamData,
                executionContext.repository,
                executionContext.prNumber,
                platformType,
            ),
        ]);
        const preview = await this.businessLogicPublisher.preview({
            request,
            result: validation,
            settings,
            headSha,
        });
        const outcome = preview.outcome;
        const tasksRead =
            outcome.kind === 'validated'
                ? [...outcome.checks.map((c) => c.task), ...outcome.thinTasks]
                : outcome.kind === 'task_too_thin'
                  ? outcome.tasks
                  : [];
        return {
            pullRequest: {
                number: executionContext.prNumber,
                url: executionContext.prUrl,
                title: executionContext.title,
                repositoryName: executionContext.repository.name,
            },
            references: validation.references.map((r) => ({
                raw: r.raw,
                id: r.id,
                kind: r.kind,
                source: r.source,
                intent: r.intent,
            })),
            attempts: validation.attempts,
            trackers: validation.trackers,
            tasks: tasksRead.map((task) => ({
                tracker: task.tracker,
                id: task.id,
                title: task.title,
                url: task.url,
                criteria: task.acceptanceCriteria ?? [],
                descriptionLength: task.description?.length ?? 0,
            })),
            verdict: toCliVerdict(
                outcome,
                toRunTasks({ ...validation, outcome }),
            ),
            comment: preview.comment,
            // Posting publishes this very result, sealed, not a second run.
            previewToken: sealPreview<SealedPreview>({
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                repositoryId: executionContext.repository.id,
                request: { ...request, diff: '' },
                result: validation,
                settings,
                headSha,
            }),
        };
    }

    /**
     * Posts the preview "Test on a pull request" showed, as the command
     * would: the sealed result, on the PR it was for. A preview of another
     * team, altered or expired is refused.
     */
    async postPreview(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        previewToken: string;
        authorize?: (repositoryId: string) => Promise<void>;
    }): Promise<{ posted: 'created' | 'updated' | 'none' }> {
        let sealed: SealedPreview;
        try {
            sealed = openPreview<SealedPreview>(params.previewToken);
        } catch (error) {
            throw new BadRequestException(
                error instanceof PreviewSealError
                    ? error.message
                    : 'The preview is not one Kody made.',
            );
        }
        if (
            sealed.organizationId !==
                params.organizationAndTeamData.organizationId ||
            sealed.teamId !== params.organizationAndTeamData.teamId
        ) {
            throw new BadRequestException('The preview is not one Kody made.');
        }
        await params.authorize?.(sealed.repositoryId);
        const published = await this.businessLogicPublisher.publish({
            request: sealed.request,
            result: sealed.result,
            settings: sealed.settings,
            trigger: 'command',
            headSha: sealed.headSha,
        });
        return { posted: published.comment };
    }

    /** The PR a run is on, so its directory's settings apply; none for a local diff. */
    private pullRequestScope(
        executionContext:
            | PullRequestValidationExecutionContext
            | LocalDiffValidationExecutionContext,
        platformType?: string,
    ) {
        return executionContext.mode === 'pull_request'
            ? {
                  number: executionContext.prNumber,
                  repositoryName: executionContext.repository.name,
                  platformType,
              }
            : undefined;
    }

    private buildRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        executionContext:
            | PullRequestValidationExecutionContext
            | LocalDiffValidationExecutionContext;
        settings: BusinessLogicSettings;
        config?: { byokModel?: string; byokModelId?: string };
        platformType?: string;
        taskInput?: string;
    }): BusinessValidationRequest {
        const { organizationAndTeamData, executionContext } = params;
        return {
            door: 'cli',
            settings: params.settings,
            byokModel: params.config?.byokModel,
            byokModelId: params.config?.byokModelId,
            organizationAndTeamData,
            repository: executionContext.repository
                ? {
                      id: executionContext.repository.id,
                      name: executionContext.repository.name,
                      owner: executionContext.repository.owner,
                  }
                : undefined,
            pullRequest:
                executionContext.mode === 'pull_request'
                    ? {
                          number: executionContext.prNumber,
                          title: executionContext.title,
                          body: executionContext.pullRequestDescription,
                          headRef: executionContext.headRef,
                          baseRef: executionContext.baseRef,
                      }
                    : undefined,
            platformType: params.platformType,
            taskInput: params.taskInput,
            diff:
                executionContext.mode === 'local_diff'
                    ? executionContext.prDiff
                    : async () =>
                          formatPullRequestDiff(
                              await this.codeManagementService.getFilesByPullRequestId(
                                  {
                                      organizationAndTeamData,
                                      repository: {
                                          id: executionContext.repository.id,
                                          name: executionContext.repository
                                              .name,
                                      },
                                      prNumber: executionContext.prNumber,
                                  },
                              ),
                          ),
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

            const configured = await this.resolveRepository({
                organizationAndTeamData,
                repositoryId: String(
                    selectedPr.repositoryData?.id ||
                        selectedPr.repositoryId ||
                        '',
                ),
            }).catch(() => undefined);
            return this.mapPullRequestContext(
                selectedPr,
                requestedUrl,
                configured,
            );
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

    /**
     * `configured` is the repository as the integration stores it: its name
     * and owner win over the PR's, which some platforms give as `owner/name`
     * (the diff then 404s).
     */
    private mapPullRequestContext(
        pr: PullRequest,
        fallbackUrl: string,
        configured?: BusinessValidationRepositoryContext,
    ): PullRequestValidationExecutionContext {
        const repositoryId =
            String(pr.repositoryData?.id || pr.repositoryId || '').trim() ||
            configured?.id;
        const repositoryName =
            configured?.name || pr.repositoryData?.name || pr.repository;
        const repositoryOwner =
            configured?.owner ||
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
            );

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
            title: pr.title,
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

        // Never another PR than the one asked for: by its link, else by the
        // number in the link, in the repository the link names.
        const normalizedRequestedUrl = this.normalizeUrl(requestedUrl);
        const match = requestedUrl.match(
            /^[a-z]+:\/\/[^/]+\/(.+?)\/(?:-\/)?(?:pulls?|merge_requests|pull-requests|pullrequest)\/(\d+)/i,
        );
        const number = Number(match?.[2]);
        const linkRepository = match?.[1].toLowerCase().replace('/_git/', '/');
        return (
            pullRequests.find(
                (pr) => this.normalizeUrl(pr.prURL) === normalizedRequestedUrl,
            ) ??
            pullRequests.find(
                (pr) =>
                    Number(pr.number || pr.pull_number) === number &&
                    this.inRepository(pr, linkRepository, pullRequests.length),
            )
        );
    }

    /**
     * Whether a PR is in the repository a link names (`acme/notes`,
     * `org/project/repo` for Azure). A PR that names no repository only
     * counts when it is the only one listed.
     */
    private inRepository(
        pr: PullRequest,
        linkRepository: string | undefined,
        listed: number,
    ): boolean {
        const names = [
            pr.repositoryData?.name,
            typeof pr.repository === 'string' ? pr.repository : undefined,
            pr.head?.repo?.fullName,
            pr.base?.repo?.fullName,
        ]
            .filter((n): n is string => !!n)
            .map((n) => n.toLowerCase());
        if (!linkRepository || !names.length) {
            return listed === 1;
        }
        // A full name says more than a bare one: `other/notes` is not `acme/notes`.
        const full = names.filter((n) => n.includes('/'));
        return (full.length ? full : names).some(
            (n) => linkRepository === n || linkRepository.endsWith(`/${n}`),
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
}

function toCliVerdict(
    outcome: BusinessValidationOutcome,
    tasks: RunTask[],
): CliBusinessVerdict {
    switch (outcome.kind) {
        case 'validated':
            return {
                status: outcome.passed ? 'compliant' : 'issues_found',
                passed: outcome.passed,
                tasks,
            };
        case 'skipped':
            return {
                status: 'skipped',
                passed: false,
                reason: outcome.reason,
                message: outcome.message,
                tasks,
            };
        default:
            return {
                status: outcome.kind,
                passed: false,
                message: outcome.message,
                tasks,
            };
    }
}
