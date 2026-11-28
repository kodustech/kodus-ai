import { suiteRunIdOfRun } from '@libs/runtime/contracts/derive-id';
import type { RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';
import type { RuntimeRunRequested, SuiteStageResult } from '@libs/runtime/run';

import type { SuiteStage } from '../run/ports';
import type { Canary } from '../canary/canary';
import type { PgSuiteRuns } from './pg-suite-runs';
import type { SuiteService, SuiteStep } from './suite-service';

/**
 * The suite as a stage of a Run (docs/runtime/e2e-suites.md sections 10.2 and 11): "one engine, both modes". The Run's request
 * carries a `suite` section (the tokens, the main commit, the PR's files); the stage turns it into the command CI mode would
 * have been given (`mode: run`, `targetId` the Run, which the product stored the publish target under), runs the same service
 * as one step group of the Run's workflow, and reads what the engine stored. A Run asked twice (a replay) names the same suite
 * run, which the engine answers instead of running again. The suite's own check is published by the service; the Run's verdict
 * reads only the findings and counts (`suiteVerdictParts`).
 */
export class SuiteRunStage implements SuiteStage {
    constructor(
        private readonly service: Pick<SuiteService, 'run'>,
        private readonly runs: Pick<PgSuiteRuns, 'get'>,
    ) {}

    async run(req: RuntimeRunRequested, step: SuiteStep, opts: { deadlineAt?: string; cancellationSignal?: () => AbortSignal | undefined; canaries?: readonly Canary[] } = {}): Promise<SuiteStageResult> {
        const s = req.suite;
        if (!s) return { status: 'off' };
        const cmd: RuntimeSuiteRequested = {
            suiteRunId: suiteRunIdOfRun(req.organizationId, req.runId),
            organizationId: req.organizationId,
            environmentId: req.environment.environmentId,
            repositoryId: req.repository.id,
            ...(req.repository.fullName ? { repositoryFullName: req.repository.fullName } : {}),
            mode: 'run',
            prNumber: req.pullRequest.number,
            prSha: req.pullRequest.headSha,
            // The true merge base when the product could say (the compare API), else the base the PR was opened against.
            mergeBase: s.mergeBase ?? req.pullRequest.baseSha,
            ...(s.mainBehind !== undefined ? { mainBehind: s.mainBehind } : {}),
            mainSha: s.mainSha,
            requestedAt: req.requestedAt,
            key: req.runId,
            targetId: req.runId,
            repoToken: s.repoToken,
            ...(s.moreRepoTokens ? { moreRepoTokens: s.moreRepoTokens } : {}),
            ...(s.changedFiles ? { changedFiles: s.changedFiles } : {}),
            ...(s.removedFiles ? { removedFiles: s.removedFiles } : {}),
            ...(s.deltaFiles ? { deltaFiles: s.deltaFiles } : {}),
            ...(s.mainSpecs ? { mainSpecs: s.mainSpecs } : {}),
            ...(req.traceparent ? { traceparent: req.traceparent } : {}),
        };
        const result = await this.service.run(cmd, step, opts);
        if (result.status === 'off') return { status: 'off' };
        if (result.status === 'unavailable') return { status: 'unavailable', reason: result.reason };
        // The classification is read once, in a step, so a replay of the Run sees what the first read saw.
        const stored = await step('suite:stage-result', async () => {
            const run = await this.runs.get(req.organizationId, result.suiteRunId);
            return { state: run?.state ?? result.state, ...(run?.classification ? { classification: run.classification } : {}) };
        });
        return { status: 'ran', state: stored.state as NonNullable<SuiteStageResult['state']>, ...(stored.classification ? { classification: stored.classification } : {}), ...(result.leaked ? { leaked: true } : {}) };
    }
}
