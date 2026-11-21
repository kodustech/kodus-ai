import type {
    BootPhase,
    CellOwner,
    RunBuildSteps,
    RunState,
    RuntimeRun,
} from "../contracts";
import { durationBetween, formatDurationMs } from "../format";
import { isTerminalRunState } from "../labels";
import type { RunStreamView } from "../stream";
import { baseVersionLabel } from "./base-version";
import { code, type RichText } from "./rich-text";

// "Why it took …": the phases of a Run in order, from the projection's own
// measures (phaseMs, bootMs) and the stream's state times, and one sentence
// on where most of the time went and why. A phase whose ends are unknown has
// no duration and the bar leaves it out; the page still lists it so a
// missing number reads as missing, not as zero.

export type RunPhaseId = "wait" | "boot" | "apply" | "test" | "report";

export type RunPhase = {
    id: RunPhaseId;
    label: string;
    ms?: number;
    detail?: string;
    /** Where the phase starts and ends, when known (the log groups by these). */
    from?: string;
    to?: string;
    /** The builds this phase ran, step by step, when the cell reported them. */
    builds?: RunBuildSteps[];
    /** Where each side's boot in this phase spent its time, when its cell reported it. */
    bootPhases?: Array<{ side: "base" | "pr"; phases: BootPhase[] }>;
    /** Still under way: `ms` counts up to now. */
    running?: boolean;
    /** The test phase's checks and, when every check had as many on both sides, its attempts per side. */
    checks?: { count: number; attempts?: number };
};

/** "42 steps · 30 cached · 1 failed". */
export const buildStepsLine = (b: RunBuildSteps) =>
    [
        `${b.steps} ${b.steps === 1 ? "step" : "steps"}`,
        b.cached ? `${b.cached} cached` : undefined,
        b.errored ? `${b.errored} failed` : undefined,
    ]
        .filter(Boolean)
        .join(" · ");

const bootPhasesOf = (
    run: Pick<RuntimeRun, "bootTiming">,
    ...sides: Array<"base" | "pr">
) => {
    const out = sides.flatMap((side) => {
        const phases = run.bootTiming?.[side]?.phases;
        return phases?.length ? [{ side, phases }] : [];
    });
    return out.length ? out : undefined;
};

const buildsOf = (
    run: Pick<RuntimeRun, "buildSteps">,
    ...sides: Array<"base" | "pr">
) => {
    const builds = (run.buildSteps ?? []).filter((b) => sides.includes(b.side));
    return builds.length ? builds : undefined;
};

export type RunTiming = {
    baseLabel?: string;
    phases: RunPhase[];
    /** From the request to the end (or to now, for a live Run). */
    totalMs?: number;
    /** Whose machines the Run waited for. */
    cellOwner?: CellOwner;
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * The checks the test sent, from the recorded probes that ran (their step
 * ids), with attempts when they are the same everywhere; else the stream's
 * planned count. "1 check · 2 attempts on each version".
 */
const checksOf = (
    run: Partial<Pick<RuntimeRun, "probes">>,
    planned: number | undefined,
    baseLabel: string,
): { checks?: RunPhase["checks"]; detail?: string } => {
    const ran = (run.probes ?? []).filter(
        (p) => (p.baseStepIds?.length ?? 0) + (p.prStepIds?.length ?? 0) > 0,
    );
    if (!ran.length)
        return planned !== undefined
            ? {
                  checks: { count: planned },
                  detail: plural(planned, "check"),
              }
            : {};
    const counts = ran.flatMap((p) => [
        p.baseStepIds?.length ?? 0,
        p.prStepIds?.length ?? 0,
    ]);
    const uniform = counts.every((n) => n === counts[0])
        ? counts[0]
        : undefined;
    const base = Math.max(...ran.map((p) => p.baseStepIds?.length ?? 0));
    const pr = Math.max(...ran.map((p) => p.prStepIds?.length ?? 0));
    return {
        checks: {
            count: ran.length,
            ...(uniform ? { attempts: uniform } : {}),
        },
        detail: `${plural(ran.length, "check")} · ${
            uniform
                ? `${plural(uniform, "attempt")} on each version`
                : `${plural(base, "attempt")} on ${baseLabel}, ${pr} on this PR`
        }`,
    };
};

const plus = (at: string | undefined, ms: number | undefined) => {
    if (!at || ms === undefined) return undefined;
    const t = Date.parse(at);
    return Number.isFinite(t) ? new Date(t + ms).toISOString() : undefined;
};

const later = (...ats: Array<string | undefined>) =>
    ats
        .filter((a): a is string => !!a && Number.isFinite(Date.parse(a)))
        .sort((a, b) => Date.parse(a) - Date.parse(b))
        .at(-1);

export const stateAt = (view: Pick<RunStreamView, "states">, state: RunState) =>
    view.states.find((s) => s.state === state)?.at;

/** When the Run reached its terminal state: the stream's, else the projection's. */
export const terminalAt = (
    run: Pick<RuntimeRun, "state" | "finishedAt">,
    view: Pick<RunStreamView, "states">,
) =>
    view.states.find((s) => isTerminalRunState(s.state))?.at ??
    (isTerminalRunState(run.state) ? run.finishedAt : undefined);

const timingParts = (
    t: NonNullable<RuntimeRun["bootTiming"]>["base"],
): string | undefined => {
    if (!t) return undefined;
    const parts = [
        t.buildMs !== undefined && `build ${formatDurationMs(t.buildMs)}`,
        t.upMs !== undefined && `start ${formatDurationMs(t.upMs)}`,
        t.readyMs !== undefined && `ready check ${formatDurationMs(t.readyMs)}`,
    ].filter(Boolean);
    return parts.length ? parts.join(" · ") : undefined;
};

export const runTiming = (
    run: Pick<
        RuntimeRun,
        | "baseBranch"
        | "state"
        | "requestedAt"
        | "finishedAt"
        | "bootingAt"
        | "bootMs"
        | "phaseMs"
        | "bootTiming"
        | "buildSteps"
    > &
        Partial<Pick<RuntimeRun, "probes" | "cellOwner">>,
    view: Pick<RunStreamView, "states" | "phases" | "verdict" | "published">,
    now: number = Date.now(),
): RunTiming => {
    const baseLabel = baseVersionLabel(run);
    const bootingAt = run.bootingAt ?? stateAt(view, "booting");
    const testingAt = stateAt(view, "testing");
    const endAt = terminalAt(run, view);
    const verdictAt = view.verdict?.at;
    const publishedAt = later(...view.published.map((p) => p.at));

    const phases: RunPhase[] = [];
    const wait = durationBetween(run.requestedAt, bootingAt);
    if (wait !== undefined && wait >= 1000)
        phases.push({
            id: "wait",
            label: "Wait for a free machine",
            detail: "Queued until a machine was free; Kody had not started yet",
            ms: wait,
            from: run.requestedAt,
            to: bootingAt,
        });

    if (run.phaseMs) {
        const mainReady = plus(bootingAt, run.phaseMs.boot);
        phases.push({
            id: "boot",
            label: `Boot ${baseLabel}`,
            ms: run.phaseMs.boot,
            detail: timingParts(run.bootTiming?.base),
            from: bootingAt,
            to: mainReady,
            builds: buildsOf(run, "base"),
            bootPhases: bootPhasesOf(run, "base"),
        });
        phases.push({
            id: "apply",
            label: "Build this PR",
            ms: run.phaseMs.apply,
            detail: timingParts(run.bootTiming?.pr),
            from: mainReady,
            to: plus(mainReady, run.phaseMs.apply),
            builds: buildsOf(run, "pr"),
            bootPhases: bootPhasesOf(run, "pr"),
        });
    } else if (bootingAt) {
        const booting =
            run.bootMs === undefined &&
            !testingAt &&
            !endAt &&
            !isTerminalRunState(run.state);
        phases.push({
            id: "boot",
            label: `Boot ${baseLabel} and build this PR`,
            ms:
                run.bootMs ??
                durationBetween(
                    bootingAt,
                    testingAt ??
                        endAt ??
                        (booting ? new Date(now).toISOString() : undefined),
                ),
            from: bootingAt,
            to: testingAt ?? plus(bootingAt, run.bootMs),
            builds: buildsOf(run, "base", "pr"),
            bootPhases: bootPhasesOf(run, "base", "pr"),
            ...(booting ? { running: true } : {}),
        });
    }

    if (testingAt) {
        const testEnd = verdictAt ?? endAt;
        const planned = view.phases.find((p) => p.phase === "replay")?.counts
            ?.probes;
        const { checks, detail } = checksOf(run, planned, baseLabel);
        phases.push({
            id: "test",
            label: "Test",
            ms: testEnd
                ? durationBetween(testingAt, testEnd)
                : durationBetween(testingAt, new Date(now).toISOString()),
            ...(detail ? { detail } : {}),
            ...(checks ? { checks } : {}),
            from: testingAt,
            to: testEnd,
            ...(testEnd ? {} : { running: true }),
        });
    }

    // Without the verdict's time, only a publish after the end bounds the report.
    const reportFrom = verdictAt ?? (publishedAt ? endAt : undefined);
    const reportTo = later(endAt, publishedAt);
    if (reportFrom && reportTo)
        phases.push({
            id: "report",
            label: "Report",
            ms: durationBetween(reportFrom, reportTo),
            from: reportFrom,
            to: reportTo,
        });

    const totalMs = durationBetween(
        run.requestedAt,
        run.finishedAt ??
            endAt ??
            (isTerminalRunState(run.state)
                ? undefined
                : new Date(now).toISOString()),
    );
    return {
        phases,
        totalMs,
        baseLabel,
        ...(run.cellOwner ? { cellOwner: run.cellOwner } : {}),
    };
};

/** "Boot 14 seconds, build of this PR 7 minutes 51 seconds…": the bar's accessible name. */
export const timingSummary = (timing: RunTiming) =>
    timing.phases
        .filter((p) => p.ms !== undefined)
        .map((p) => `${p.label} ${formatDurationMs(p.ms)}`)
        .join(", ");

/** The step that ran longest in these builds, as "service name". */
const slowestStep = (builds: RunBuildSteps[] | undefined) =>
    (builds ?? []).flatMap((b) => b.slowest).sort((a, b) => b.ms - a.ms)[0];

/** The boot sub-step that took longest. */
const longestBootPhase = (phase: RunPhase) =>
    (phase.bootPhases ?? [])
        .flatMap((b) => b.phases)
        .sort((a, b) => b.ms - a.ms)[0];

/**
 * A build step as a sentence can carry it: without BuildKit's "[build 3/3]",
 * "RUN" and --mount flags, cut at 60 characters (the phase row keeps it whole).
 */
export const shortStepName = (name: string) => {
    const bare = name
        .replace(/^\[[^\]]*\]\s*/, "")
        .replace(/^RUN\s+/, "")
        .replace(/--mount=\S+\s*/g, "")
        .trim();
    return bare.length > 60 ? `${bare.slice(0, 59)}…` : bare;
};

/** Why a boot or build phase took its time: its slowest step, else its longest sub-step. */
const bootWhy = (phase: RunPhase): RichText => {
    const step = slowestStep(phase.builds);
    if (step)
        return [
            "; its slowest step was ",
            code(`${step.service} ${shortStepName(step.name)}`),
            ` (${formatDurationMs(step.ms)})`,
        ];
    const sub = longestBootPhase(phase);
    return sub
        ? [
              "; most of it was ",
              code(sub.name),
              ` (${formatDurationMs(sub.ms)})`,
          ]
        : [];
};

/**
 * One sentence for the collapsed "Why it took …": the phase that took most
 * of the time and why, from the measures only. "Most" only past half of the
 * measured time; else "the longest part". Nothing before a phase is measured.
 */
export const timingTakeaway = (
    timing: RunTiming,
    { live }: { live: boolean },
): RichText | undefined => {
    const baseLabel = timing.baseLabel ?? baseVersionLabel();
    const measured = timing.phases.filter((p) => (p.ms ?? 0) > 0);
    if (!measured.length) return undefined;
    const sum = measured.reduce((s, p) => s + (p.ms ?? 0), 0);
    const top = measured.reduce((a, b) => ((b.ms ?? 0) > (a.ms ?? 0) ? b : a));
    const took = `(${formatDurationMs(top.ms)})`;
    const lead =
        (top.ms ?? 0) * 2 > sum ? "most of it was" : "the longest part was";
    const opening = live
        ? `So far, ${lead}`
        : lead[0].toUpperCase() + lead.slice(1);
    const whose =
        timing.cellOwner === "customer"
            ? "one of your machines"
            : "a Kodus machine";
    const body: RichText = (() => {
        switch (top.id) {
            case "wait":
                return [
                    `waiting for a free machine ${took}: the Run was queued until ${whose} was free, and Kody had not started yet`,
                ];
            case "boot":
                return [
                    timing.phases.some((p) => p.id === "apply")
                        ? `booting ${baseLabel} ${took}`
                        : `booting ${baseLabel} and building this PR ${took}`,
                    ...bootWhy(top),
                ];
            case "apply":
                return [`building this PR ${took}`, ...bootWhy(top)];
            case "test": {
                const c = top.checks;
                return [
                    `testing ${took}`,
                    c
                        ? c.attempts
                            ? `: ${plural(c.count, "check")} × 2 versions × ${plural(c.attempts, "attempt")}`
                            : `: ${plural(c.count, "check")} on both versions`
                        : "",
                ];
            }
            case "report":
                return [
                    `writing the report and posting it on the pull request ${took}`,
                ];
        }
    })();
    return [`${opening} `, ...body, "."];
};
