import type { EvidenceSide, RunBuildSteps, RuntimeRun } from "../contracts";
import { formatDurationMs, formatUtcClock, shortSha } from "../format";
import {
    cellOwnerLabel,
    isFailingOutcome,
    isTerminalRunState,
    RUN_PATH_OUTCOME_META,
    runStateLabel,
} from "../labels";
import type { RunStepView, RunStreamView } from "../stream";
import { baseVersionLabel } from "./base-version";
import { publicationLine } from "./publication";
import type { RunPaths } from "./run-paths";
import { buildStepsLine, type RunTiming } from "./run-timing";

// The Run log: everything the cells ran, in order, grouped by phase (boot
// main, build this PR, explore, test, report). Built from the stream's
// states, phases and steps, the projection's exploration and the product's
// publication record. Every step keeps its evidence key.

export type RunLogGroupId = "boot" | "apply" | "explore" | "test" | "report";
export type RunLogTone = "default" | "ok" | "fail" | "warn" | "muted";
export type RunLogStatus = "ok" | "warn" | "failed" | "running" | "pending";

export type RunLogLine = {
    id: string;
    at?: string;
    side?: string;
    /** A command as it ran: drawn after a `$` prompt. */
    command?: string;
    text: string;
    result?: { text: string; tone: RunLogTone };
    durationMs?: number;
    failed: boolean;
    /** An incomplete comparison or terminal result that needs investigation. */
    attention?: boolean;
    evidence?: { stepId: string; side: EvidenceSide; label?: string };
};

export type RunLogGroup = {
    id: RunLogGroupId;
    title: string;
    /** "5 of 5 commands failed". */
    note?: string;
    status: RunLogStatus;
    durationMs?: number;
    lines: RunLogLine[];
};

const evidenceSide = (side: string | undefined): EvidenceSide =>
    side === "base" || side === "setup" ? side : "pr";

const sideName = (side: string | undefined, baseLabel: string) =>
    side === "base" ? baseLabel : side === "pr" ? "pr" : side;

/** What a step was, in the log's words. */
export const stepText = (step: RunStepView) => {
    if (step.kind === "probe.run" && step.probeId === "run-ready")
        return "app readiness check";
    if (step.kind === "probe.run")
        return `check ${step.probeId ?? step.label ?? ""}`.trim();
    if (step.kind === "machine.reset") return "reset the machine";
    if (step.kind === "exec") return step.label ?? "run a command";
    return step.label ?? step.probeId ?? step.kind ?? "step";
};

const OUTCOME_TEXT: Record<string, string> = {
    timeout: "timed out",
    refused: "refused by the machine",
    transport_lost: "no answer",
    security_violation: "security violation",
};

/** What a step answered, with its tone; a lost, refused or non-zero step fails. */
export const stepResult = (
    step: RunStepView,
): { text: string; tone: RunLogTone; failed: boolean } => {
    if (!step.finishedAt)
        return { text: "running", tone: "muted", failed: false };
    if (step.outcome && step.outcome !== "ok")
        return {
            text: OUTCOME_TEXT[step.outcome] ?? step.outcome.replace(/_/g, " "),
            tone: "fail",
            failed: true,
        };
    if (step.transport === "lost")
        return { text: "no answer", tone: "fail", failed: true };
    if (step.vmHealth && step.vmHealth !== "ok")
        return { text: `machine ${step.vmHealth}`, tone: "fail", failed: true };
    if (step.status !== undefined)
        return {
            text: String(step.status),
            tone: step.status >= 500 ? "fail" : "ok",
            failed: false,
        };
    if (step.exitCode !== undefined)
        return {
            text: `exit ${step.exitCode}`,
            tone: step.exitCode === 0 ? "ok" : "fail",
            failed: step.exitCode !== 0,
        };
    return { text: "done", tone: "ok", failed: false };
};

const statusOf = (
    lines: RunLogLine[],
    running: boolean,
    warn = false,
): RunLogStatus =>
    lines.some((l) => l.failed)
        ? "failed"
        : running
          ? "running"
          : warn
            ? "warn"
            : lines.length
              ? "ok"
              : "pending";

const plus = (at: string | undefined, ms: number | undefined) => {
    if (!at || ms === undefined) return undefined;
    const t = Date.parse(at);
    return Number.isFinite(t) ? new Date(t + ms).toISOString() : undefined;
};

/** A side's build: one summary line, then its slowest steps. */
export const buildLines = (
    b: RunBuildSteps,
    at?: string,
    baseLabel = baseVersionLabel(),
): RunLogLine[] => [
    {
        id: `build-${b.side}`,
        at,
        side: sideName(b.side, baseLabel),
        text: `build · ${buildStepsLine(b)}`,
        result: b.errored
            ? { text: `${b.errored} failed`, tone: "fail" }
            : { text: "built", tone: "ok" },
        failed: b.errored > 0,
    },
    ...b.slowest.map((s, i) => ({
        id: `build-${b.side}-slow-${i}`,
        side: sideName(b.side, baseLabel),
        text: `${s.service} · ${s.name}`,
        durationMs: s.ms,
        failed: false,
    })),
];

const byTime = (a: RunLogLine, b: RunLogLine) =>
    (a.at ? Date.parse(a.at) : Infinity) - (b.at ? Date.parse(b.at) : Infinity);

export const buildRunLog = (
    run: Pick<
        RuntimeRun,
        | "state"
        | "attempt"
        | "requestedAt"
        | "finishedAt"
        | "reason"
        | "cellOwner"
        | "headSha"
        | "baseSha"
        | "baseBranch"
        | "bootingAt"
        | "phaseMs"
        | "buildSteps"
        | "exploration"
        | "publication"
        | "verdictState"
    >,
    view: Pick<
        RunStreamView,
        "states" | "phases" | "steps" | "verdict" | "published"
    >,
    runPaths: Pick<
        RunPaths,
        "paths" | "testedCount" | "totalCount" | "coverageKnown"
    >,
    timing: RunTiming,
): RunLogGroup[] => {
    const baseLabel = baseVersionLabel(run);
    const phaseMs = (id: string) => timing.phases.find((p) => p.id === id)?.ms;
    const bootingAt =
        run.bootingAt ?? view.states.find((s) => s.state === "booting")?.at;
    const testing = view.states.find((s) => s.state === "testing");
    const live = !isTerminalRunState(run.state);
    const couldNotBoot = run.state === "could_not_boot";

    // Boot main (and, without phaseMs, the PR too).
    const boot: RunLogLine[] = [
        {
            id: "requested",
            at: run.requestedAt,
            text: `requested · attempt ${run.attempt}`,
            failed: false,
        },
    ];
    for (const s of view.states) {
        if (s.state === "awaiting_approval")
            boot.push({
                id: `state-${s.state}`,
                at: s.at,
                text: "waiting for a maintainer to approve this Run",
                failed: false,
            });
    }
    if (bootingAt)
        boot.push({
            id: "booting",
            at: bootingAt,
            text: `asked for the machines: ${baseLabel} ${shortSha(run.baseSha)} and this PR ${shortSha(run.headSha)} · ${cellOwnerLabel(run.cellOwner)}`,
            failed: false,
        });
    const apply: RunLogLine[] = [];
    const baseBuild = run.buildSteps?.find((b) => b.side === "base");
    const prBuild = run.buildSteps?.find((b) => b.side === "pr");
    if (run.phaseMs) {
        const mainReady = plus(bootingAt, run.phaseMs.boot);
        if (baseBuild)
            boot.push(...buildLines(baseBuild, undefined, baseLabel));
        boot.push({
            id: "main-ready",
            at: mainReady,
            text: `${baseLabel} is ready`,
            result: { text: "ready", tone: "ok" },
            durationMs: run.phaseMs.boot,
            failed: false,
        });
        if (prBuild) apply.push(...buildLines(prBuild, undefined, baseLabel));
        apply.push({
            id: "pr-ready",
            at: plus(mainReady, run.phaseMs.apply),
            text: "this PR is built and ready",
            result: { text: "ready", tone: "ok" },
            durationMs: run.phaseMs.apply,
            failed: false,
        });
    } else {
        for (const b of [baseBuild, prBuild])
            if (b) boot.push(...buildLines(b, undefined, baseLabel));
    }
    if (!run.phaseMs && testing) {
        boot.push({
            id: "both-ready",
            at: testing.at,
            text: `${baseLabel} and this PR are ready`,
            result: { text: "ready", tone: "ok" },
            failed: false,
        });
    }
    if (couldNotBoot) {
        const end = view.states.find((s) => s.state === "could_not_boot");
        (run.phaseMs ? apply : boot).push({
            id: "could-not-boot",
            at: end?.at ?? run.finishedAt,
            text: run.reason
                ? `could not boot: ${run.reason}`
                : "could not boot",
            result: { text: "failed", tone: "fail" },
            failed: true,
        });
    }

    // Explore: the commands Kody ran on main before writing its probes.
    const stepById = new Map(view.steps.map((s) => [s.stepId, s]));
    const exploration = run.exploration ?? [];
    const explored = new Set(exploration.map((c) => c.stepId));
    const agent = view.phases.find((p) => p.phase === "agent");
    const explore: RunLogLine[] = [];
    if (agent?.counts?.entryPoints !== undefined)
        explore.push({
            id: "agent",
            at: agent.at,
            text: `Kody read the diff · ${agent.counts.entryPoints} ${agent.counts.entryPoints === 1 ? "entry point" : "entry points"}`,
            failed: false,
        });
    for (const c of [...exploration].sort((a, b) => a.index - b.index)) {
        const step = stepById.get(c.stepId);
        explore.push({
            id: `explore-${c.stepId}`,
            at: step?.startedAt,
            side: sideName("base", baseLabel),
            command: c.command,
            text: c.command,
            result: c.error
                ? { text: c.error.replace(/_/g, " "), tone: "fail" }
                : c.exitCode !== undefined
                  ? {
                        text: `exit ${c.exitCode}`,
                        tone: c.exitCode === 0 ? "ok" : "fail",
                    }
                  : undefined,
            durationMs: c.durationMs,
            failed: c.failed,
            evidence: {
                stepId: c.stepId,
                side: "base",
                label: "Command output",
            },
        });
    }
    const exploreFailed = exploration.filter((c) => c.failed).length;

    // Test: every other step, in order, then each path's verdict.
    const test: RunLogLine[] = [];
    if (testing)
        test.push({
            id: "testing",
            at: testing.at,
            text: "preparing to compare the same checks on both versions",
            failed: false,
        });
    const replay = view.phases.find((p) => p.phase === "replay");
    if (replay?.counts?.probes !== undefined)
        test.push({
            id: "replay",
            at: replay.at,
            text: `${replay.counts.probes} ${replay.counts.probes === 1 ? "check" : "checks"} planned`,
            failed: false,
        });
    for (const step of view.steps) {
        if (explored.has(step.stepId)) continue;
        const result = stepResult(step);
        test.push({
            id: `step-${step.stepId}`,
            at: step.startedAt ?? step.finishedAt,
            side: sideName(step.side, baseLabel),
            text: stepText(step),
            result: { text: result.text, tone: result.tone },
            durationMs: step.durationMs,
            failed: result.failed,
            evidence: step.finishedAt
                ? {
                      stepId: step.stepId,
                      side: evidenceSide(step.side),
                      label:
                          step.kind === "machine.reset"
                              ? "Reset log"
                              : step.kind === "probe.run"
                                ? "Response details"
                                : "Command output",
                  }
                : undefined,
        });
    }
    test.sort(byTime);
    for (const path of runPaths.paths) {
        const meta = RUN_PATH_OUTCOME_META[path.outcome];
        test.push({
            id: `path-${path.probeId}-${path.entryPoint}`,
            at: view.verdict?.at,
            text: `${path.entryPoint}: ${meta.label}`,
            result:
                path.differingFields.length && path.outcome !== "same"
                    ? {
                          text: `differs in ${path.differingFields.join(", ")}`,
                          tone: isFailingOutcome(path.outcome)
                              ? "fail"
                              : "warn",
                      }
                    : undefined,
            failed: false,
            attention: path.outcome !== "same",
        });
    }

    const compared = new Set(
        runPaths.paths
            .filter((path) => path.outcome !== "could_not_test")
            .map((path) => path.probeId),
    );
    const incomplete =
        !runPaths.coverageKnown ||
        compared.size === 0 ||
        runPaths.totalCount === 0 ||
        runPaths.testedCount < runPaths.totalCount ||
        runPaths.paths.some((path) => path.outcome === "could_not_test");
    if (!live && compared.size > 0 && !runPaths.coverageKnown)
        test.push({
            id: "comparison-coverage-unknown",
            text: "The record does not include coverage of all changed paths. The comparisons below do not establish coverage of the whole PR.",
            result: { text: "coverage not recorded", tone: "warn" },
            attention: true,
            failed: false,
        });
    if (!live && test.length && compared.size === 0)
        test.push({
            id: "comparison-missing",
            text: "No behavioral comparison was recorded. Readiness and setup checks do not establish a result for this PR.",
            result: { text: "comparison incomplete", tone: "warn" },
            attention: true,
            failed: false,
        });
    if (
        !live &&
        compared.size > 0 &&
        runPaths.testedCount < runPaths.totalCount
    ) {
        const remaining = runPaths.totalCount - runPaths.testedCount;
        test.push({
            id: "comparison-incomplete",
            text: `${remaining} changed ${remaining === 1 ? "path has" : "paths have"} no recorded comparison.`,
            result: { text: "comparison incomplete", tone: "warn" },
            attention: true,
            failed: false,
        });
    }
    if (!live && compared.size > 0 && runPaths.testedCount === 0)
        test.push({
            id: "comparison-outside-diff",
            text: "No changed path was compared. Observations outside this PR do not establish coverage of its changes.",
            attention: true,
            failed: false,
        });

    // Report: the verdict, then what reached the pull request.
    const report: RunLogLine[] = [];
    if (view.verdict)
        report.push({
            id: "verdict",
            at: view.verdict.at,
            text: `verdict ${runStateLabel(view.verdict.verdictState ?? run.verdictState ?? run.state).toLowerCase()} · ${runPaths.testedCount} of ${runPaths.totalCount} paths`,
            failed: false,
            attention:
                incomplete ||
                runPaths.paths.some((path) => path.outcome !== "same"),
        });
    const recordedEnd = view.states.find((s) => s.state === run.state);
    const end = !live
        ? {
              state: run.state,
              at: recordedEnd?.at ?? run.finishedAt,
              reason: recordedEnd?.reason ?? run.reason,
          }
        : view.states.find((s) => isTerminalRunState(s.state));
    if (end)
        report.push({
            id: "terminal",
            at: end.at,
            text: `state ${runStateLabel(end.state).toLowerCase()}${end.state !== "errored" && end.reason ? ` · ${end.reason}` : ""}`,
            failed: false,
            attention: [
                "errored",
                "timed_out",
                "halted",
                "partly_tested",
                "could_not_boot",
                "regression",
            ].includes(end.state),
        });
    let reportWarn = false;
    const publication = run.publication;
    if (publication && !publication.postsToPullRequest) {
        report.push({
            id: "simulation",
            text: "simulation: nothing is posted on the pull request",
            failed: false,
        });
    } else if (publication) {
        for (const kind of ["check", "comment"] as const) {
            const v = publication[kind];
            const line = publicationLine(kind, v);
            const failed = v.status === "failed";
            const warn = v.retrying || v.fallback || line.tone === "warning";
            const attention = !!warn || (v.status === "pending" && !live);
            reportWarn ||= attention;
            report.push({
                id: `publication-${kind}`,
                at: v.at,
                text: `${kind} → ${line.label.toLowerCase()}${line.detail ? ` · ${line.detail}` : ""}`,
                result: {
                    text: v.status.replace(/_/g, " "),
                    tone: failed
                        ? "fail"
                        : warn
                          ? "warn"
                          : v.status === "published"
                            ? "ok"
                            : "muted",
                },
                failed,
                attention,
            });
        }
    } else {
        for (const p of view.published)
            report.push({
                id: `published-${p.at}-${p.kind ?? ""}`,
                at: p.at,
                text: `sent to the pull request${p.kind ? ` · ${p.kind}` : ""}`,
                failed: false,
            });
    }

    const groups: RunLogGroup[] = [
        {
            id: "boot",
            title: run.phaseMs
                ? `Boot ${baseLabel}`
                : `Boot ${baseLabel} and build this PR`,
            status: statusOf(
                boot,
                live && !testing && !run.phaseMs && !!bootingAt,
            ),
            durationMs: phaseMs("boot"),
            lines: boot,
        },
    ];
    if (run.phaseMs || (couldNotBoot && apply.length))
        groups.push({
            id: "apply",
            title: "Build this PR",
            status: statusOf(apply, false),
            durationMs: phaseMs("apply"),
            lines: apply,
        });
    if (explore.length)
        groups.push({
            id: "explore",
            title: `Explore the app on ${baseLabel}`,
            note: exploration.length
                ? exploreFailed
                    ? `${exploreFailed} of ${exploration.length} commands failed`
                    : `${exploration.length} ${exploration.length === 1 ? "command" : "commands"}`
                : undefined,
            status: statusOf(explore, false),
            durationMs:
                exploration.reduce((sum, c) => sum + (c.durationMs ?? 0), 0) ||
                undefined,
            lines: explore,
        });
    if (test.length || run.state === "testing")
        groups.push({
            id: "test",
            title: `Compare ${baseLabel} and this PR`,
            note: [
                replay?.counts?.probes !== undefined
                    ? `${replay.counts.probes} ${replay.counts.probes === 1 ? "check" : "checks"} planned`
                    : undefined,
                compared.size
                    ? `${compared.size} ${compared.size === 1 ? "comparison" : "comparisons"} recorded`
                    : "No comparison recorded",
            ]
                .filter(Boolean)
                .join(" · "),
            status:
                live &&
                run.state !== "testing" &&
                compared.size === 0 &&
                !test.some((line) => line.failed)
                    ? "pending"
                    : statusOf(
                          test,
                          run.state === "testing",
                          incomplete || test.some((line) => line.attention),
                      ),
            durationMs: phaseMs("test"),
            lines: test,
        });
    if (report.length)
        groups.push({
            id: "report",
            title:
                publication && !publication.postsToPullRequest
                    ? "Report"
                    : "Report on the PR",
            status: statusOf(
                report,
                false,
                reportWarn || report.some((line) => line.attention),
            ),
            durationMs: phaseMs("report"),
            lines: report,
        });
    return groups;
};

export type RunLogFilter = { query?: string; onlyFailures?: boolean };

const lineMatches = (line: RunLogLine, query: string) =>
    [line.text, line.result?.text, line.side]
        .filter(Boolean)
        .some((t) => t!.toLowerCase().includes(query));

/** The groups with only the lines that pass; with a filter on, empty groups go. */
export const filterRunLog = (
    groups: RunLogGroup[],
    filter: RunLogFilter,
): RunLogGroup[] => {
    const query = filter.query?.trim().toLowerCase() ?? "";
    if (!query && !filter.onlyFailures) return groups;
    return groups
        .map((g) => ({
            ...g,
            lines: g.lines.filter(
                (l) =>
                    (!filter.onlyFailures || l.failed || l.attention) &&
                    (!query || lineMatches(l, query)),
            ),
        }))
        .filter((g) => g.lines.length > 0);
};

const MARK: Record<RunLogStatus, string> = {
    ok: "✓",
    warn: "!",
    failed: "!",
    running: "…",
    pending: "·",
};

export const groupMark = (status: RunLogStatus) => MARK[status];

/** Groups open at first: the failed ones; with none failed, the running one. */
export const initiallyOpen = (groups: RunLogGroup[]) => {
    const failed = groups.filter((g) => g.status === "failed");
    if (failed.length) return new Set(failed.map((g) => g.id));
    const running = groups.find((g) => g.status === "running");
    const warning = groups.find((g) => g.status === "warn");
    return new Set(running ? [running.id] : warning ? [warning.id] : []);
};

/** The plain text of the log (Copy, Download raw): every line, UTC clock. */
export const runLogText = (
    groups: RunLogGroup[],
    opts: { timestamps?: boolean } = {},
): string => {
    const out: string[] = [];
    for (const g of groups) {
        out.push(
            `${MARK[g.status]} ${g.title}${g.note ? ` · ${g.note}` : ""}${g.durationMs !== undefined ? ` (${formatDurationMs(g.durationMs)})` : ""}`,
        );
        for (const l of g.lines) {
            const parts = [
                opts.timestamps === false
                    ? undefined
                    : l.at
                      ? formatUtcClock(l.at)
                      : " ".repeat(8),
                l.side ? l.side.padEnd(4) : undefined,
                l.command !== undefined ? `$ ${l.command}` : l.text,
                l.result ? `→ ${l.result.text}` : undefined,
                l.durationMs !== undefined
                    ? `· ${formatDurationMs(l.durationMs)}`
                    : undefined,
            ].filter(Boolean);
            out.push(`  ${parts.join(" ")}`);
        }
    }
    return out.join("\n") + "\n";
};
