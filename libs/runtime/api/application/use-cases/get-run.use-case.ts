import { Inject, Injectable, Optional } from '@nestjs/common';

import { RUNTIME_RUN_TARGET_STORE_TOKEN, type RunTargetStore } from '@libs/runtime-publish/domain/run-target';
import { runPublicationViewOf, type RunPublicationView } from '@libs/runtime-publish/domain/run-publication-view';
import { RUNTIME_PUBLICATION_READER_TOKEN, type PublicationReader } from '@libs/runtime-publish/domain/runtime-publication';
import type { RuntimeRunProjection } from '@libs/runtime/run';

import {
    RUNTIME_FINDING_FEEDBACK_STORE,
    RUNTIME_FINDING_INTENT_STORE,
    type FindingFeedbackRecord,
    type FindingIntentRecord,
    type FindingIntentStore,
    type FindingFeedbackStore,
    type FindingFeedbackValue,
} from '../../domain/ports';
import type { RuntimeRunCost } from '../../domain/run-cost';
import { RuntimeRunCostService } from '../run-cost.service';
import { RuntimeRunAccessService, type RuntimePrincipal } from '../run-access.service';
import { publicRunCheck, publicRunReason } from '../run-public-view';

/** 👍/👎 counts of one tested path, and the caller's own vote. */
export interface FindingFeedbackView {
    up: number;
    down: number;
    mine?: FindingFeedbackValue;
}

export type RuntimeRunDetail = Omit<RuntimeRunProjection, 'correlationId' | 'reproduction' | 'published' | 'publishStartedAt'> & {
    /** Findings a developer can reproduce on their machine (GET …/findings/:probeId/reproduce), by probeId. */
    reproducible: string[];
    /** What each reproducible probe sent and expected, by probeId (shape only, redacted). */
    probeRequests: Record<string, ProbeRequestView>;
    check: { conclusion: string; title: string };
    /** Machine time and LLM tokens at list prices: an estimate (§11, PR 5). */
    cost: RuntimeRunCost;
    /** By probeId. */
    feedback: Record<string, FindingFeedbackView>;
    /**
     * Findings a developer marked "this change is intended", by probeId. A
     * learning signal only: the verdict, the check and the comment still say
     * what Kody measured.
     */
    intendedBy: Record<string, FindingIntentView>;
    /**
     * What the product published on the PR, from its own publication rows
     * (ADR-052). The projection's `published` only says the Runtime asked, so
     * it is left out. Absent where the publication store is not wired.
     */
    publication?: RunPublicationView;
};

/**
 * What a probe sent and expected, for the finding cards: from the reproduction
 * (secrets already redacted), and only the shape of the request — never an
 * HTTP body, a SQL query or browser input text.
 */
export interface ProbeRequestView {
    kind: 'http' | 'sql' | 'browser';
    method?: string;
    service?: string;
    port?: number;
    path?: string;
    purpose: string;
    expected: string;
}

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

/** Who marked a finding intended, and when; `mine` when it was the caller. */
export interface FindingIntentView {
    userId: string;
    at: string;
    mine: boolean;
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
    ) {}

    async execute(input: { principal: RuntimePrincipal; runId: string }): Promise<RuntimeRunDetail> {
        const run = await this.access.load(input.principal, input.runId);
        // The probes themselves stay out of the detail: the reproduce route serves a data-only manifest.
        const { correlationId: _internal, reproduction, published: _requested, publishStartedAt: _requestedAt, reason: rawReason, ...rest } = run;
        const reason = publicRunReason(run.state, rawReason);
        const userId = input.principal.kind === 'user' ? input.principal.user?.uuid : undefined;
        const votes = this.feedback ? await this.feedback.listForRun(run.organizationId, run.runId) : [];
        const marks = this.intents ? await this.intents.listForRun(run.organizationId, run.runId) : [];
        const publication = await this.publicationOf(run);
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
        };
    }

    /**
     * The product's own record of the PR: its publish target (none for a
     * simulation) and its publication rows, read in the Run's org only.
     */
    private async publicationOf(run: RuntimeRunProjection): Promise<RunPublicationView | undefined> {
        if (!this.publications || !this.targets) return undefined;
        const [target, rows] = await Promise.all([
            this.targets.get(run.runId),
            this.publications.listForRun(run.organizationId, run.runId),
        ]);
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
