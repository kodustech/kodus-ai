import type { ProbeVerdict, RuntimeRun } from "../contracts";
import {
    isFailingOutcome,
    RUN_PATH_OUTCOME_ORDER,
    type RunPathOutcome,
} from "../labels";
import type { RunStepView } from "../stream";
import { baseVersionLabel } from "./base-version";
import type { ReplayLanes } from "./replay-lanes";

// One row per tested path (product screen 8): what was sent on main and on
// the PR, what was expected and what came back, each step with its time and
// its evidence. Built from the Run projection (verdicts and the step ids
// behind them) and the stream (step timing and result).

export type { RunPathOutcome };

export type RunPathStep = {
    stepId: string;
    side: "base" | "pr";
    title: string;
    /** For the PR side: what main answered. */
    expected?: string;
    observed: string;
    /** true = as expected; false = differs; undefined = still running or unknown. */
    ok?: boolean;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
};

export type RunPath = {
    probeId: string;
    /** The coverage id: a diff entry point, or 'unmapped' for a probe outside them (S-32). */
    entryPoint: string;
    /** What the screens show: the entry point, or what an outside probe sent ("GET /api/health"). */
    route: string;
    /** The probe reached none of this PR's entry points: shown, never counted as covering one. */
    outsideDiff: boolean;
    /** The recorded comparison reference; absent on hand-built/older view models. */
    baseLabel?: string;
    /** The changed file with no route of its own that this route reaches: Kody's mapping, never measured coverage of the file. */
    via?: string;
    outcome: RunPathOutcome;
    /** One line: "400 on main, 500 on this PR". */
    summary: string;
    /** What the first round of each side answered ("200", "exit 1"), when it ran. */
    answers?: { main: string; pr: string };
    reason: string;
    differingFields: string[];
    steps: RunPathStep[];
    /** Main and this PR on one clock for one round each (absent on older Runs). */
    lanes?: ReplayLanes;
};

export type UntestedPath = { entryPoint: string; reason: string };

/** The coverage id of a probe that reached none of the diff's entry points. */
export const OUTSIDE_DIFF_ENTRY_POINT = "unmapped";
export const OUTSIDE_DIFF_MARKER = "outside this PR's paths";

/** The route a path shows: what an outside probe sent (from its typed spec), never the bare 'unmapped'. */
export const shownRouteOf = (
    p: Pick<ProbeVerdict, "entryPoint" | "exercised">,
): { route: string; outsideDiff: boolean } =>
    p.entryPoint === OUTSIDE_DIFF_ENTRY_POINT
        ? { route: p.exercised || "A path", outsideDiff: true }
        : { route: p.entryPoint, outsideDiff: false };

export const outcomeOf = (p: ProbeVerdict): RunPathOutcome => {
    if (p.verdict === "finding") {
        if (p.intent === "intended") return "intended";
        return p.findingKind === "new_endpoint_error"
            ? "new_endpoint_error"
            : "regression";
    }
    if (p.verdict === "new_endpoint") return "new_endpoint";
    // A difference the PR's own text describes and that held: the PR's intended change.
    if (p.verdict === "described_change") return "intended";
    if (p.verdict === "not_reproduced") return "same";
    if (p.verdict === "pre_existing") return "pre_existing";
    return "could_not_test";
};

/** What one step answered, in the words of the screen. */
export const resultOf = (step: RunStepView | undefined): string => {
    if (!step) return "not recorded";
    if (!step.finishedAt) return "running";
    if (step.transport === "lost") return "no answer";
    if (step.status !== undefined) return String(step.status);
    if (step.exitCode !== undefined) return `exit ${step.exitCode}`;
    return "done";
};

const sideSteps = (ids: string[] | undefined, byId: Map<string, RunStepView>) =>
    (ids ?? []).map((stepId) => ({ stepId, step: byId.get(stepId) }));

export type RunPaths = {
    paths: RunPath[];
    untested: UntestedPath[];
    /** The projection explicitly records the changed paths left uncovered. */
    coverageKnown: boolean;
    /** Unique changed entry points with a recorded comparison verdict. */
    testedCount: number;
    /** Unique changed entry points; observations outside the diff do not count. */
    totalCount: number;
};

export function buildRunPaths(
    run: Pick<
        RuntimeRun,
        "probes" | "findings" | "uncoveredEntryPoints" | "baseBranch"
    >,
    streamSteps: RunStepView[],
): RunPaths {
    const baseLabel = baseVersionLabel(run);
    const byId = new Map(streamSteps.map((s) => [s.stepId, s]));
    // The projection's probes include the findings; older Runs only had findings.
    const probes = new Map<string, ProbeVerdict>();
    for (const p of [...(run.findings ?? []), ...(run.probes ?? [])])
        probes.set(`${p.probeId}::${p.entryPoint}`, p);

    const paths = [...probes.values()].map((p): RunPath => {
        const base = sideSteps(p.baseStepIds, byId);
        const pr = sideSteps(p.prStepIds, byId);
        const mainResult = resultOf(base[0]?.step);
        const outcome = outcomeOf(p);
        const { route, outsideDiff } = shownRouteOf(p);
        const differs = isFailingOutcome(outcome) || outcome === "intended";
        // A route this PR adds: main answers it as absent, so the PR is not held to main's answer.
        const added =
            outcome === "new_endpoint" || outcome === "new_endpoint_error";
        const steps: RunPathStep[] = [
            ...base.map(({ stepId, step }, i) => ({
                stepId,
                side: "base" as const,
                title: `Send ${route} on ${baseLabel}${base.length > 1 ? ` (attempt ${i + 1})` : ""}`,
                observed: resultOf(step),
                ok:
                    step?.finishedAt && outcome !== "could_not_test"
                        ? step.transport !== "lost"
                        : undefined,
                startedAt: step?.startedAt,
                finishedAt: step?.finishedAt,
                durationMs: step?.durationMs,
            })),
            ...pr.map(({ stepId, step }) => {
                const observed = resultOf(step);
                const sameStatus = observed === mainResult;
                const fields = p.differingFields?.filter((f) => f !== "status");
                return {
                    stepId,
                    side: "pr" as const,
                    title: "Send the same request on this PR",
                    expected: added
                        ? `An answer under 500 (${baseLabel} has no such route${mainResult === "not recorded" ? "" : `: ${mainResult}`})`
                        : mainResult === "not recorded"
                          ? `The same answer as ${baseLabel}`
                          : `${mainResult}, like ${baseLabel}`,
                    observed:
                        differs && !added && sameStatus && fields?.length
                            ? `${observed}, differs in ${fields.join(", ")}`
                            : observed,
                    ok:
                        step?.finishedAt && outcome !== "could_not_test"
                            ? (added ? outcome === "new_endpoint" : !differs) &&
                              step.transport !== "lost"
                            : undefined,
                    startedAt: step?.startedAt,
                    finishedAt: step?.finishedAt,
                    durationMs: step?.durationMs,
                };
            }),
        ];
        const prResult = resultOf(pr[0]?.step);
        const summary =
            outcome === "could_not_test"
                ? "could not test"
                : base.length || pr.length
                  ? `${mainResult} on ${baseLabel}, ${prResult} on this PR`
                  : outcome === "same"
                    ? `same result on ${baseLabel} and PR`
                    : `differs from ${baseLabel}`;
        return {
            probeId: p.probeId,
            entryPoint: p.entryPoint,
            route,
            outsideDiff,
            baseLabel,
            ...(p.via && !outsideDiff ? { via: p.via } : {}),
            outcome,
            summary,
            answers:
                base.length || pr.length
                    ? { main: mainResult, pr: prResult }
                    : undefined,
            reason: p.reason,
            differingFields: p.differingFields ?? [],
            steps,
            ...(p.lanes ? { lanes: p.lanes } : {}),
        };
    });
    paths.sort(
        (a, b) =>
            RUN_PATH_OUTCOME_ORDER[a.outcome] -
            RUN_PATH_OUTCOME_ORDER[b.outcome],
    );

    const tested = new Set(
        paths
            .filter((p) => !p.outsideDiff && p.outcome !== "could_not_test")
            .map((p) => p.entryPoint),
    );
    const untested = [...new Set(run.uncoveredEntryPoints ?? [])]
        .filter((e) => !tested.has(e) && !paths.some((p) => p.entryPoint === e))
        .map((entryPoint) => ({ entryPoint, reason: "No check reached it" }));
    return {
        paths,
        untested,
        coverageKnown: Array.isArray(run.uncoveredEntryPoints),
        testedCount: tested.size,
        totalCount: new Set([
            ...paths.filter((p) => !p.outsideDiff).map((p) => p.entryPoint),
            ...(run.uncoveredEntryPoints ?? []),
        ]).size,
    };
}

/**
 * What a check is called on the screens: what it set out to check, as Kody
 * wrote it, else its id in words ("signup-invalid-email" → "Signup invalid
 * email"). Two checks of one route are told apart by it. None for an opaque id.
 */
export const checkLabel = (probeId: string, purpose?: string) => {
    const written = purpose?.trim();
    if (written) return written;
    if (!/[a-z]/i.test(probeId) || /^[0-9a-f-]{16,}$/i.test(probeId))
        return undefined;
    const words = probeId.replace(/[-_.:]+/g, " ").trim();
    return words ? words[0]!.toUpperCase() + words.slice(1) : undefined;
};
