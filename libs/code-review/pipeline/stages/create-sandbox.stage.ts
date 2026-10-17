import { CloneParamsResolverService } from '../services/clone-params-resolver.service';
import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { FeatureGateService, FEATURE_KEYS } from '@libs/feature-gate';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';
import type { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';
import {
    CustomAgentCliProvisioning,
    provisionCustomAgentClis,
} from '@libs/code-review/infrastructure/agents/custom-agent-cli/custom-agent-cli.provisioner';

import {
    ISandboxLeaseManager,
    SANDBOX_LEASE_MANAGER_TOKEN,
    SandboxInvalidatedError,
} from '@libs/sandbox/domain/contracts/sandbox-lease-manager.contract';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { CliReviewPipelineContext } from '@libs/cli-review/pipeline/context/cli-review-pipeline.context';

/**
 * After review finishes, only keep the sandbox warm for 30 seconds. Either
 * `@kody` arrives in a hot window (likely seconds after the review comment
 * lands) — and benefits from warm-resume — or the user takes their time and
 * comes back well past the lease TTL anyway, where cold-start is unavoidable.
 * 30s strikes the balance without keeping a paused sandbox occupying an E2B
 * concurrent slot for the full default 5-min idle window.
 */
const REVIEW_IDLE_TIMEOUT_MS = 30_000;

/**
 * Creates and stores a sandbox instance in the pipeline context.
 *
 * Extracted from CollectCrossFileContextStage so that the sandbox can be
 * shared across multiple downstream stages (agent review, safeguard, etc.)
 * without coupling sandbox lifecycle to cross-file context collection.
 *
 * After plan 01-04: delegates to SandboxLeaseManager instead of calling
 * ISandboxProvider directly. Cleanup closes the lease (release) rather than
 * killing the sandbox — enabling E2B pause/resume across reviews of the same PR.
 */
@Injectable()
export class CreateSandboxStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'CreateSandboxStage';
    readonly label = 'Preparing Sandbox';
    readonly visibility = StageVisibility.SECONDARY;

    private readonly logger = createLogger(CreateSandboxStage.name);

    constructor(
        @Inject(SANDBOX_LEASE_MANAGER_TOKEN)
        private readonly leaseManager: ISandboxLeaseManager,
        private readonly cloneParamsResolver: CloneParamsResolverService,
        // Optional so specs that build the stage by hand keep compiling;
        // without them no team CLI is installed.
        @Optional()
        private readonly featureGate?: FeatureGateService,
        @Optional()
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService?: IOrganizationService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        // Skip if sandbox already exists (e.g. created by CollectCrossFileContext in v2)
        if (context.sandboxHandle) {
            this.logger.log({
                message: 'Sandbox already exists in context, skipping creation',
                context: this.stageName,
            });
            return context;
        }

        const isCliMode = context.origin === 'cli';
        const cliContext = isCliMode
            ? (context as unknown as CliReviewPipelineContext)
            : undefined;
        const label = isCliMode
            ? `branch ${cliContext?.gitContext?.branch ?? 'unknown'}`
            : `PR#${context?.pullRequest?.number}`;

        // Trial mode: we still try to spin a sandbox so the agent can use
        // tools instead of falling back to single-shot self-contained mode.
        // For public repos this works with no auth at all; for private
        // repos the user can pass a personal access token via
        // `--github-pat`. If the clone fails (no auth + private), the
        // catch block below logs and falls through to self-contained
        // mode — same UX as before, just opt-in upgraded for public repos.

        // Guard: skip if no changed files
        if (!context?.changedFiles?.length) {
            this.logger.log({
                message: `Skipping sandbox creation: no changed files for ${label}`,
                context: this.stageName,
            });
            return context;
        }

        // Guard (CLI): skip if no git remote available
        if (isCliMode && !cliContext?.gitContext?.remote) {
            this.logger.log({
                message: `Skipping sandbox creation: no git remote in CLI context`,
                context: this.stageName,
            });
            return context;
        }

        // Build a stable per-PR key for lease coordination.
        // CLI mode uses branch name instead of PR number.
        const prKey = isCliMode
            ? `${context.organizationAndTeamData?.organizationId}:${context.repository?.id}:cli:${cliContext?.gitContext?.branch ?? 'unknown'}`
            : `${context.organizationAndTeamData?.organizationId}:${context.repository?.id}:${context.pullRequest?.number}`;

        try {
            const cloneInfo = await this.cloneParamsResolver.resolve(
                context,
                cliContext,
            );
            if (!cloneInfo) {
                this.logger.warn({
                    message: `resolveCloneParams returned null for ${label}`,
                    context: this.stageName,
                });
                return context;
            }

            this.logger.log({
                message: `Acquiring sandbox lease for ${label}`,
                context: this.stageName,
                metadata: {
                    prKey,
                    cloneUrl: cloneInfo.url,
                    platform: cloneInfo.platform,
                    branch: cloneInfo.branch,
                    prNumber: cloneInfo.prNumber,
                    hasAuthToken: !!cloneInfo.authToken,
                },
            });

            // The lease manager owns retry+backoff for the underlying provider
            // call (3 attempts with 60s/120s backoffs). If acquire() throws here
            // it means all attempts failed — review continues self-contained.
            const { sandbox, leaseId } = await this.leaseManager.acquire(
                prKey,
                'review',
                undefined,
                {
                    cloneUrl: cloneInfo.url,
                    authToken: cloneInfo.authToken,
                    authUsername: cloneInfo.authUsername,
                    branch: cloneInfo.branch,
                    baseBranch: cloneInfo.baseBranch,
                    prNumber: cloneInfo.prNumber,
                    platform: cloneInfo.platform,
                    checkoutSha: cloneInfo.checkoutSha,
                    unifiedDiff: cliContext?.cliRawDiff,
                    sandboxMetadata: { stage: 'review' },
                },
            );

            // Override cleanup so the observer's context.sandboxHandle.cleanup()
            // releases the lease (pause) rather than killing the sandbox.
            // 30s idle window — see REVIEW_IDLE_TIMEOUT_MS rationale.
            sandbox.cleanup = async () => {
                await this.leaseManager.release(leaseId, {
                    idleMs: REVIEW_IDLE_TIMEOUT_MS,
                });
            };

            this.logger.log({
                message: `Sandbox lease acquired for ${label} (type=${sandbox.type}, baseBranch=${sandbox.baseBranch || 'none'})`,
                context: this.stageName,
                metadata: {
                    sandboxType: sandbox.type,
                    baseBranch: sandbox.baseBranch,
                    leaseId,
                },
            });

            const customAgentClis = isCliMode
                ? undefined
                : await this.provisionCustomAgentClis(context, sandbox);

            return this.updateContext(context, (draft) => {
                draft.sandboxHandle = sandbox;
                if (customAgentClis) draft.customAgentClis = customAgentClis;
                draft.getFreshCloneParams = async () => {
                    const freshCloneInfo =
                        await this.cloneParamsResolver.resolve(
                            context,
                            cliContext,
                        );
                    if (!freshCloneInfo) {
                        throw new Error(
                            'Failed to resolve fresh clone parameters',
                        );
                    }
                    return {
                        cloneUrl: freshCloneInfo.url,
                        authToken: freshCloneInfo.authToken,
                        authUsername: freshCloneInfo.authUsername,
                        branch: freshCloneInfo.branch,
                        baseBranch: freshCloneInfo.baseBranch,
                        prNumber: freshCloneInfo.prNumber,
                        platform: freshCloneInfo.platform,
                        checkoutSha: freshCloneInfo.checkoutSha,
                        unifiedDiff: cliContext?.cliRawDiff,
                        sandboxMetadata: { stage: 'agent-review-renewed' },
                    };
                };
            });
        } catch (err) {
            // A mid-acquire invalidation is a SUPERSEDE, not a failure: the PR
            // was closed or force-pushed, so this review is moot (a force-push
            // re-triggers a fresh review on the new head). Log it as such
            // instead of a false "all retries exhausted" error that pollutes
            // error rates / alerts. The review still continues self-contained.
            if (err instanceof SandboxInvalidatedError) {
                this.logger.warn({
                    message: `Sandbox lease superseded for ${label} (PR closed or force-pushed) — continuing without it`,
                    context: this.stageName,
                    metadata: {
                        organizationAndTeamData:
                            context?.organizationAndTeamData,
                        prNumber: context?.pullRequest?.number,
                    },
                });
                return this.updateContext(context, (draft) => {
                    draft.sandboxSuperseded = true;
                });
            }
            this.logger.error({
                message: `Failed to acquire sandbox lease for ${label} (all retries exhausted), continuing without it`,
                context: this.stageName,
                error: err,
                metadata: {
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                },
            });
            return context;
        }
    }

    /**
     * Install the team CLIs of the custom agents that will run (#2172), before
     * any agent or secret touches the sandbox. Only on E2B and only for orgs
     * with the feature on; a failure here never fails the review.
     */
    private async provisionCustomAgentClis(
        context: CodeReviewPipelineContext,
        sandbox: SandboxInstance,
    ): Promise<CustomAgentCliProvisioning | undefined> {
        const agents = context.codeReviewConfig?.customAgents ?? [];
        if (
            sandbox.type !== 'e2b' ||
            !this.featureGate ||
            !agents.some((agent) => agent?.enabled && agent.tools?.cli?.length)
        ) {
            return undefined;
        }

        const org = context.organizationAndTeamData;
        try {
            const releaseTrack =
                await this.organizationService?.getReleaseTrack(
                    org.organizationId,
                );
            const enabled = await this.featureGate.isEnabled(
                FEATURE_KEYS.customAgents,
                {
                    identifier: org.organizationId,
                    organizationAndTeamData: org,
                    releaseTrack,
                },
            );
            if (!enabled) return undefined;

            const provisioning = await provisionCustomAgentClis({
                sandbox,
                agents,
                changedFiles: (context.changedFiles ?? [])
                    .map((file) => file?.filename)
                    .filter(Boolean),
            });
            this.logger.log({
                message: `Custom agent CLIs ready: ${Object.values(
                    provisioning.byAgentId,
                ).reduce(
                    (n, list) => n + list.length,
                    0,
                )} installed, ${provisioning.warnings.length} failed`,
                context: this.stageName,
                metadata: { organizationId: org.organizationId },
            });
            return provisioning;
        } catch (error) {
            this.logger.error({
                message: 'Custom agent CLI provisioning failed',
                context: this.stageName,
                error,
                metadata: { organizationId: org?.organizationId },
            });
            return undefined;
        }
    }
}
