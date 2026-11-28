import { insertionOrderJson, sha256Hex } from '@libs/runtime/contracts/derive-id';

import type { RunProjectionStore, RuntimeRunProjection } from '@libs/runtime/run';

import type { AgentPlan } from '../agent/runtime-agent';

// The same pull request head, run again, gets the same plan (planner-eval.md
// fix 1, P1): a Run whose head, base, environment, entry points, targets and
// planner version are those of an earlier Run that reached a verdict takes
// that Run's accepted plan from its workflow's `agent:plan` step instead of
// asking the model again. Only an accepted plan is reused (no refused item,
// no plan-less answer), so a plan that went wrong is never locked in by
// reuse; anything that changes the plan's input changes the key.

/** Earlier Runs of the same PR read for a plan, newest first. */
export const PLAN_REUSE_RUNS = 3;

/** Verdicts a Run's plan was replayed to the end for. */
const DECIDED: ReadonlySet<string> = new Set(['no_regressions', 'regression', 'partly_tested']);

export interface PlanReuseInput {
    headSha: string;
    baseSha: string;
    environmentId: string;
    entryPoints: string[];
    targets: unknown;
    plannerVersion: string;
}

/** The key of a plan's input: two Runs with the same key ask the planner the same question. */
export function planReuseKey(input: PlanReuseInput): string {
    // insertionOrderJson, not canonicalJson: the shipped key keeps the targets' key order.
    return sha256Hex(insertionOrderJson([input.plannerVersion, input.headSha, input.baseSha, input.environmentId, [...input.entryPoints].sort(), input.targets]));
}

/** A plan that may stand for a later Run: accepted, with probes or cannotProve lines, and made for this key. */
export function reusable(plan: unknown, key: string): plan is AgentPlan {
    const p = plan as Partial<AgentPlan> | null;
    return !!p && p.reuseKey === key && Array.isArray(p.probes) && Array.isArray(p.rejected) && p.rejected.length === 0 && !p.securityViolation && (p.probes.length > 0 || (p.cannotProve?.length ?? 0) > 0);
}

export interface PastPlans {
    find(q: { organizationId: string; repositoryId: string; prNumber: number; runId: string; headSha: string; baseSha: string; environmentId: string; key: string }): Promise<{ runId: string; plan: AgentPlan } | undefined>;
}

/** A finished workflow's step outputs, by step name (DBOS.listWorkflowSteps in production). */
export type ListSteps = (workflowId: string) => Promise<Array<{ name: string; output: unknown }> | undefined>;

/** A step output as stored, or wrapped by its serializer ({json, meta}). */
const unwrap = (o: unknown): unknown => (o && typeof o === 'object' && 'json' in o && Object.keys(o).every((k) => k === 'json' || k === 'meta') ? (o as { json: unknown }).json : o);

/** The plan a Run used: the one made while the PR booted, else the one made after. */
function planOf(steps: Array<{ name: string; output: unknown }>): unknown {
    const early = unwrap(steps.find((s) => s.name === 'agent:plan:early')?.output) as { kind?: string; plan?: unknown } | undefined;
    if (early?.kind === 'planned') return early.plan;
    const late = unwrap(steps.find((s) => s.name === 'agent:plan')?.output) as { claimFailure?: unknown } | undefined;
    return late && !late.claimFailure ? late : undefined;
}

export class StepPastPlans implements PastPlans {
    constructor(
        private readonly projection: Pick<RunProjectionStore, 'list'>,
        private readonly listSteps: ListSteps,
    ) {}

    async find(q: Parameters<PastPlans['find']>[0]) {
        const runs: RuntimeRunProjection[] = await this.projection.list({ organizationId: q.organizationId, repositoryId: q.repositoryId, prNumber: q.prNumber, limit: 50 });
        const same = runs
            .filter((r) => r.runId !== q.runId && r.headSha === q.headSha && r.baseSha === q.baseSha && r.environmentId === q.environmentId && DECIDED.has(r.verdictState ?? ''))
            .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt))
            .slice(0, PLAN_REUSE_RUNS);
        for (const r of same) {
            const steps = await this.listSteps(r.runId);
            const plan = steps && planOf(steps);
            if (reusable(plan, q.key)) return { runId: r.runId, plan };
        }
        return undefined;
    }
}
