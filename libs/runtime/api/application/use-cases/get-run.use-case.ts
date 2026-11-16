import { stuckRuns } from '@libs/runtime/health/stuck';
import { Inject, Injectable, Optional } from '@nestjs/common';

import { RUNTIME_RUN_TARGET_STORE_TOKEN, type RunTarget, type RunTargetStore } from '@libs/runtime-publish/domain/run-target';
import { runPublicationViewOf, type RunPublicationView } from '@libs/runtime-publish/domain/run-publication-view';
import { RUNTIME_PUBLICATION_READER_TOKEN, type PublicationReader } from '@libs/runtime-publish/domain/runtime-publication';
import type { RuntimeRunProjection } from '@libs/runtime/run';
import type { FindingFeedbackView, FindingIntentView, ProbeRequestView, RuntimeRunDetail } from '@libs/runtime/contracts/views/run';

import {
    type Clock,
    RUNTIME_CLOCK,
    RUNTIME_FINDING_FEEDBACK_STORE,
    RUNTIME_FINDING_INTENT_STORE,
    type FindingFeedbackRecord,
    type FindingIntentRecord,
    type FindingIntentStore,
    type FindingFeedbackStore,
} from '../../domain/ports';
import { RuntimeRunCostService } from '../run-cost.service';
import { RuntimeRunAccessService, type RuntimePrincipal } from '../run-access.service';
import { publicRunCheck, publicRunReason } from '../run-public-view';

// The views live in contracts/views/run.ts (the web imports them too); re-exported for the callers that imported them from here.
export type { FindingFeedbackView, FindingIntentView, ProbeRequestView, RuntimeRunDetail };

export function probeRequestsOf(reproduction: RuntimeRunProjection['reproduction']): Record<string, ProbeRequestView> {
    const out: Record<string, ProbeRequestView> = {};
    for (const p of reproduction?.probes ?? []) {
        const base = { purpose: p.purpose.slice(0, 512), expected: p.expected.slice(0, 512) };
        const spec = p.spec;
        if (spec.kind === 'http') {
            out[p.probeId] = { kind: 'http', method: spec.method, service: spec.target.service, port: spec.target.port, path: spec.path.slice(0, 1_024), ...base };
        } else if (spec.kind === 'browser') {
            const goto = spec.steps.find((s): s is { goto: string } => 'goto' in s);
            out[p.probeId] = { kind: 'browser', ...(goto ? { path: goto.goto.slice(0, 1_024) } : {}), ...base };
        } else {
            out[p.probeId] = { kind: 'sql', ...base };
        }
    }
    return out;
}

export function intendedView(rows: FindingIntentRecord[], userId?: string): Record<string, FindingIntentView> {
    const out: Record<string, FindingIntentView> = {};
    for (const r of rows) out[r.probeId] = { userId: r.userId, at: r.markedAt, mine: !!userId && r.userId === userId };
    return out;
}

export function feedbackView(rows: FindingFeedbackRecord[], userId?: string): Record<string, FindingFeedbackView> {
    const out: Record<string, FindingFeedbackView> = {};
    for (const r of rows) {
        const v = (out[r.probeId] ??= { up: 0, down: 0 });
        v[r.value] += 1;
        if (userId && r.userId === userId) v.mine = r.value;
    }
    return out;
}

/** GET /runtime/runs/:id — steps, findings, coverage, cost and feedback of one Run. */
@Injectable()
export class GetRuntimeRunUseCase {
    constructor(
        private readonly access: RuntimeRunAccessService,
        private readonly costs: RuntimeRunCostService,
        @Optional()
        @Inject(RUNTIME_FINDING_FEEDBACK_STORE)
        private readonly feedback?: FindingFeedbackStore,
        @Optional()
        @Inject(RUNTIME_PUBLICATION_READER_TOKEN)
        private readonly publications?: PublicationReader,
        @Optional()
        @Inject(RUNTIME_RUN_TARGET_STORE_TOKEN)
        private readonly targets?: Pick<RunTargetStore, 'get'>,
        @Optional()
        @Inject(RUNTIME_FINDING_INTENT_STORE)
        private readonly intents?: FindingIntentStore,
        @Optional()
        @Inject(RUNTIME_CLOCK)
        private readonly clock?: Clock,
    ) {}

    async execute(input: { principal: RuntimePrincipal; runId: string }): Promise<RuntimeRunDetail> {
        const run = await this.access.load(input.principal, input.runId);
        // The probes themselves stay out of the detail: the reproduce route serves a data-only manifest.
        const { correlationId: _internal, reproduction, published: _requested, publishStartedAt: _requestedAt, reason: rawReason, ...rest } = run;
        const reason = publicRunReason(run.state, rawReason);
        const userId = input.principal.kind === 'user' ? input.principal.user?.uuid : undefined;
        const votes = this.feedback ? await this.feedback.listForRun(run.organizationId, run.runId) : [];
        const marks = this.intents ? await this.intents.listForRun(run.organizationId, run.runId) : [];
        const target = this.targets ? await this.targets.get(run.runId, { organizationId: run.organizationId }) : null;
        const publication = await this.publicationOf(run, target);
        const workspace = target && target.organizationId === run.organizationId ? target.workspace : undefined;
        const [stuck] = stuckRuns([run], this.clock?.() ?? new Date());
        return {
            ...rest,
            ...(reason === undefined ? {} : { reason }),
            reproducible: reproduction?.probes.map((p) => p.probeId) ?? [],
            probeRequests: probeRequestsOf(reproduction),
            check: publicRunCheck(run),
            cost: (await this.costs.forRuns([run])).get(run.runId)!,
            feedback: feedbackView(votes, userId),
            intendedBy: intendedView(marks, userId),
            ...(publication ? { publication } : {}),
            ...(workspace?.length ? { workspace: workspace.map((r) => ({ ...r })) } : {}),
            ...(stuck ? { stuck: { state: stuck.state, since: stuck.since, ageMs: stuck.ageMs, boundMs: stuck.boundMs } } : {}),
        };
    }

    /**
     * The product's own record of the PR: its publish target (none for a
     * simulation) and its publication rows, read in the Run's org only.
     */
    private async publicationOf(run: RuntimeRunProjection, target: RunTarget | null): Promise<RunPublicationView | undefined> {
        if (!this.publications || !this.targets) return undefined;
        const rows = await this.publications.listForRun(run.organizationId, run.runId);
        return runPublicationViewOf({
            runId: run.runId,
            attempt: run.attempt,
            state: run.state,
            // A target of another org never counts: the Run was loaded for this org only.
            postsToPullRequest: !!target && target.organizationId === run.organizationId,
            rows: rows.filter((r) => r.organizationId === run.organizationId),
        });
    }
}
