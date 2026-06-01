import { Inject, Injectable } from '@nestjs/common';
import { createLogger } from '@kodus/flow';

import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { FeatureGateService } from '@libs/feature-gate/application/feature-gate.service';
import { FEATURE_KEYS } from '@libs/feature-gate/domain/feature-keys';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import {
    AGENT_BRANCH_STAGE_NAMES,
    EE_BRANCH_STAGE_NAMES,
} from '../strategy/engine-branches.const';
import {
    buildRepositoryDirectoryKey,
    buildRepositoryWideKey,
} from '../utils/repository-directory-key';
import { resolveTouchedDirectoryIds } from '../utils/resolve-touched-directories';

/**
 * Picks which engine handles this PR — agent mode or EE mode. The
 * unified pipeline contains both branches; this gate calls
 * `skipStages([...])` to bypass whichever branch lost. Default is agent
 * mode; the `agent-review` flag is consulted and any denial drops the
 * PR to EE mode (any-opt-out).
 *
 * The flag is keyed on the `repositoryDirectory` group in PostHog. Two
 * shapes of composite key are probed:
 *   - `${repositoryId}:*` — repo-wide opt-out (always probed once per PR).
 *   - `${repositoryId}:${directoryId}` — per-touched-directory opt-out.
 *
 * Repo-wide takes precedence: a denial there short-circuits before the
 * per-directory loop runs. This covers repos with no directories
 * configured (no per-dir keys exist for them; the repo-wide key is the
 * only way to opt them out) AND lets you opt out a whole repo even
 * when it has directories configured (just add `${repo}:*` to the
 * flag's list).
 *
 * Decision precedence:
 *   1. `API_AGENT_REVIEW_ENABLED` env override → agent (admin escape).
 *   2. Probe `${repositoryId}:*`. Denial → EE.
 *   3. Probe each touched directory's composite. First denial → EE.
 *   4. Anything else → agent.
 *
 * Marked silent so the UI/timeline never shows this internal decision.
 * Runs right after `ResolveConfigStage` (so `preliminaryFiles` and
 * `codeReviewConfig.directoryFolders` are populated) and before
 * `FetchChangedFilesStage` (which reads `useAgentEngine` for its
 * max-files limit).
 */
@Injectable()
export class SelectReviewEngineStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'SelectReviewEngineStage';
    readonly visibility = StageVisibility.INTERNAL;
    readonly silent = true;

    private readonly logger = createLogger(SelectReviewEngineStage.name);

    constructor(
        private readonly featureGate: FeatureGateService,
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,
    ) {
        super();
    }

    protected override async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const useAgent = await this.decideUseAgent(context);
        const stagesToSkip = useAgent
            ? EE_BRANCH_STAGE_NAMES
            : AGENT_BRANCH_STAGE_NAMES;

        const withEngine = this.updateContext(context, (draft) => {
            draft.pipelineMetadata = {
                ...(draft.pipelineMetadata ?? {}),
                useAgentEngine: useAgent,
            };
        });
        return this.skipStages(withEngine, stagesToSkip);
    }

    private async decideUseAgent(
        context: CodeReviewPipelineContext,
    ): Promise<boolean> {
        const envOverride =
            process.env.API_AGENT_REVIEW_ENABLED?.toLowerCase();
        if (envOverride === 'true' || envOverride === '1') {
            this.logger.log({
                message:
                    '[ENGINE-SELECT] agent forced by API_AGENT_REVIEW_ENABLED',
                context: this.stageName,
                metadata: {
                    repositoryId: context.repository?.id,
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                },
            });
            return true;
        }

        const repositoryId = context.repository?.id;
        if (!repositoryId) {
            // Composite key needs the repositoryId. Without it we can't
            // build any group key, so the gate is a no-op and the
            // default (agent) stands.
            this.logger.warn({
                message:
                    '[ENGINE-SELECT] no repository id on context — skipping opt-out probes',
                context: this.stageName,
            });
            return true;
        }

        const orgId = context.organizationAndTeamData?.organizationId;
        const identifier =
            orgId || context.organizationAndTeamData?.teamId || 'unknown';
        const releaseTrack = orgId
            ? await this.organizationService.getReleaseTrack(orgId)
            : undefined;

        // Step 1: probe the repo-wide opt-out (`${repoId}:*`). Covers
        // repos with no directories configured AND lets you opt out a
        // whole repo even when it has directories. A denial here
        // short-circuits before the per-directory loop runs.
        const repoWideKey = buildRepositoryWideKey(repositoryId);
        try {
            const repoWideEnabled = await this.featureGate.isEnabled(
                FEATURE_KEYS.agentReview,
                {
                    identifier,
                    organizationAndTeamData: context.organizationAndTeamData,
                    releaseTrack,
                    groups: { repositoryDirectory: repoWideKey },
                },
            );
            if (!repoWideEnabled) {
                this.logger.log({
                    message: `[ENGINE-SELECT] ${repoWideKey} opted out — dropping to EE mode`,
                    context: this.stageName,
                    metadata: { repositoryDirectory: repoWideKey, repositoryId },
                });
                return false;
            }
        } catch (err) {
            // Probe failure for the repo-wide key: treat as not-opted-out
            // and continue to the per-directory loop. Same fail-open
            // semantic as below.
            this.logger.warn({
                message:
                    '[ENGINE-SELECT] repo-wide probe failed — continuing to per-directory probes',
                context: this.stageName,
                metadata: {
                    repositoryDirectory: repoWideKey,
                    repositoryId,
                    error: err instanceof Error ? err.message : String(err),
                },
            });
        }

        // Step 2: probe each touched directory. Repos with no
        // directoryFolders or PRs that touch none → this loop is empty
        // and the function returns true (agent mode).
        const folders = context.codeReviewConfig?.directoryFolders ?? [];
        const paths = (context.preliminaryFiles ?? []).map(
            (file) => file.filename,
        );
        const touchedDirectoryIds = resolveTouchedDirectoryIds(paths, folders);

        for (const directoryId of touchedDirectoryIds) {
            const repositoryDirectory = buildRepositoryDirectoryKey(
                repositoryId,
                directoryId,
            );
            try {
                const directoryEnabled = await this.featureGate.isEnabled(
                    FEATURE_KEYS.agentReview,
                    {
                        identifier,
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        releaseTrack,
                        groups: { repositoryDirectory },
                    },
                );
                if (!directoryEnabled) {
                    this.logger.log({
                        message: `[ENGINE-SELECT] ${repositoryDirectory} opted out — dropping to EE mode`,
                        context: this.stageName,
                        metadata: {
                            repositoryDirectory,
                            directoryId,
                            repositoryId,
                        },
                    });
                    return false;
                }
            } catch (err) {
                // Probe failure for this directory: treat as not-opted-out
                // and keep checking the rest. A transient PostHog outage
                // therefore doesn't silently force everyone to EE — it
                // just means the failing directory can't veto.
                this.logger.warn({
                    message:
                        '[ENGINE-SELECT] directory probe failed — skipping this directory and continuing',
                    context: this.stageName,
                    metadata: {
                        repositoryDirectory,
                        directoryId,
                        repositoryId,
                        error:
                            err instanceof Error ? err.message : String(err),
                    },
                });
            }
        }

        return true;
    }
}
