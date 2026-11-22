import type { ResponseDiff, RunState, VerdictState } from "../contracts";
import { shortSha } from "../format";
import { isTerminalRunState, runStateLabel, type Tone } from "../labels";
import { baseVersionLabel } from "./base-version";

// Kody Runtime on the pull requests screens: what POST
// /runtime/pull-request-runs answers for a page of PRs
// (libs/runtime/api/domain/pull-request-runs.ts), and how the list, its
// filters and the commit timeline read it. Pure and tested.

/** One field that answers differently, both values redacted and cut by the API. */
export type PrRunDifferingField = { path: string; base?: string; pr?: string };

export type PrRunFirstRegression = {
    /** What the probe set out to check, as Kody wrote it. */
    title?: string;
    field?: PrRunDifferingField;
    differingFields: string[];
    /** The HTTP status of each side when they differ: the change a reader should see first. */
    status?: { base: number; pr: number };
    /** This PR does not boot while main does. */
    boot: boolean;
    /** The machine itself failed on this PR. */
    destabilizes: boolean;
};

export type PrRunView = {
    runId: string;
    attempt: number;
    headSha: string;
    baseBranch?: string;
    environmentId: string;
    state: RunState;
    verdictState?: VerdictState;
    phase?: string;
    requestedAt: string;
    startedAt?: string;
    finishedAt?: string;
    regressions: number;
    /** 5xx on endpoints the PR adds: not regressions, though the Run fails. Absent when none. */
    newEndpointErrors?: number;
    probes: number;
    bootFailureSide?: "base" | "pr";
    firstRegression?: PrRunFirstRegression;
};

export type PrRuntimeEnvironment = {
    environmentId: string;
    name: string;
    /** Its setup finished: a Run can start on it. */
    ready: boolean;
    /** Kody Runtime is not off for the repository. */
    on: boolean;
    /** Only when the repository is in several environments: its place in this one. */
    role?: "primary" | "member";
    /** A PR of the repository starts a Run of this one ("Run on this PR" without an environment runs only there). */
    triggers?: boolean;
    /** Every repository the environment holds, the primary first: starting a Run of it needs Create over each one. */
    repositoryIds?: string[];
};

export type PrRuntime = {
    repositoryId: string;
    prNumber: number;
    /** The environment the repository is the primary of; else the first that runs its PRs. */
    environment: PrRuntimeEnvironment | null;
    /** Every environment the repository is part of, only when there are several. */
    environments?: PrRuntimeEnvironment[];
    /**
     * The API's answer to whether "Run on this PR" can start: an environment
     * that triggers on the repository is ready, Kody Runtime is on for it and
     * not off for another repository of that environment.
     */
    canRequestRun?: boolean;
    /** The latest Run of the PR, of any of its environments. */
    latest: PrRunView | null;
    /** The latest Run of each commit, newest first. */
    commits: PrRunView[];
};

export const prRuntimeKey = (repositoryId: string, prNumber: number) =>
    `${repositoryId}#${prNumber}`;

export const runHref = (runId: string) =>
    `/runtime/runs/${encodeURIComponent(runId)}`;

const sameSha = (a: string | null | undefined, b: string | null | undefined) =>
    !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** What the Runtime column of one PR says. */
export type PrRuntimeCell =
    /** The repository has no Runtime environment. */
    | { kind: "no_environment" }
    /** The Runtime state could not be read (the call failed): unknown, not absent. */
    | { kind: "unavailable" }
    /** A failing Run: `count` regressions (0 when it failed only on new endpoints) and `newEndpointErrors`. */
    | {
          kind: "regression";
          count: number;
          newEndpointErrors?: number;
          runId: string;
          stale?: string;
      }
    | { kind: "clean"; probes: number; runId: string; stale?: string }
    | { kind: "running"; label: string; runId: string; stale?: string }
    | {
          kind: "could_not_boot";
          /** Which side did not boot: main (the environment) or this PR. */
          where?: "environment" | "PR";
          runId: string;
          stale?: string;
      }
    /** Never ran; `canRequest` when a Run can start, else `reason` says why when the answer tells. */
    | { kind: "not_run"; canRequest: boolean; reason?: string }
    | {
          kind: "other";
          label: string;
          tone: Tone;
          runId: string;
          stale?: string;
      };

export const isLiveRunState = (state: RunState | string) =>
    !isTerminalRunState(state);

/** "booting", "capacity wait": the phase in words, else the state. */
export const livePhaseLabel = (run: Pick<PrRunView, "state" | "phase">) => {
    if (run.state === "awaiting_approval") return "waiting for a maintainer";
    const phase = run.phase?.trim();
    // A side waits for room on a host (ADR-070): the projection's phase is `capacity`.
    if (phase === "capacity") return "waiting for a host";
    return (phase ? phase : runStateLabel(run.state))
        .replace(/[_-]+/g, " ")
        .toLowerCase();
};

/**
 * The short SHA of the latest Run when the PR has a newer commit it did not
 * run on. `head` is the newest commit Kodus knows (the latest review's),
 * with when it was seen: a review older than the Run says nothing.
 */
export const staleRunSha = (
    run: Pick<PrRunView, "headSha" | "requestedAt">,
    head: { sha?: string | null; at?: string } | undefined,
): string | undefined => {
    if (!head?.sha || sameSha(head.sha, run.headSha)) return undefined;
    if (head.at && Date.parse(head.at) < Date.parse(run.requestedAt))
        return undefined;
    return shortSha(run.headSha);
};

/**
 * What a failing Run found, in the Run page's words: "2 regressions",
 * "1 error on a new endpoint", or both. A 5xx on an endpoint the PR adds is
 * never counted as a regression.
 */
export const failureWords = (found: {
    count: number;
    newEndpointErrors?: number;
}): string => {
    const n = found.newEndpointErrors ?? 0;
    const parts = [
        ...(found.count > 0 || n === 0
            ? [`${found.count} regression${found.count === 1 ? "" : "s"}`]
            : []),
        ...(n > 0
            ? [
                  n === 1
                      ? "1 error on a new endpoint"
                      : `${n} errors on new endpoints`,
              ]
            : []),
    ];
    return parts.join(" · ");
};

/** The verdict of one Run in the words of the column. */
export const runCell = (
    run: PrRunView,
    stale?: string,
): Exclude<
    PrRuntimeCell,
    { kind: "no_environment" | "not_run" | "unavailable" }
> => {
    const extra = stale ? { stale } : {};
    if (isLiveRunState(run.state))
        return {
            kind: "running",
            label: livePhaseLabel(run),
            runId: run.runId,
            ...extra,
        };
    if (
        run.state === "regression" ||
        run.regressions > 0 ||
        (run.newEndpointErrors ?? 0) > 0
    ) {
        const newEndpointErrors = run.newEndpointErrors ?? 0;
        return {
            kind: "regression",
            // A failing Run with nothing counted reads as one regression, as before.
            count:
                run.regressions > 0 || newEndpointErrors > 0
                    ? run.regressions
                    : 1,
            ...(newEndpointErrors > 0 ? { newEndpointErrors } : {}),
            runId: run.runId,
            ...extra,
        };
    }
    if (run.state === "no_regressions")
        return {
            kind: "clean",
            probes: run.probes,
            runId: run.runId,
            ...extra,
        };
    if (run.state === "could_not_boot")
        return {
            kind: "could_not_boot",
            ...(run.bootFailureSide
                ? {
                      where:
                          run.bootFailureSide === "base"
                              ? ("environment" as const)
                              : ("PR" as const),
                  }
                : {}),
            runId: run.runId,
            ...extra,
        };
    return {
        kind: "other",
        label: runStateLabel(run.state),
        tone:
            run.state === "partly_tested"
                ? "alert"
                : run.state === "timed_out" || run.state === "errored"
                  ? "warning"
                  : run.state === "halted"
                    ? "danger"
                    : "neutral",
        runId: run.runId,
        ...extra,
    };
};

/**
 * The Run whose verdict a PR shows: the latest of its main environment (the
 * one its repository is the primary of) when the repository is in several,
 * else the latest. The answer carries the PR's latest Run and the latest Run
 * of each commit, of any environment; when the main one's Run is not among
 * them, the latest of any environment stands in, and the screens name it.
 */
export const mainRunOf = (runtime: PrRuntime): PrRunView | null => {
    if (!runtime.latest) return null;
    const main = runtime.environment?.environmentId;
    if (!main || !(runtime.environments?.length ?? 0)) return runtime.latest;
    return (
        [runtime.latest, ...runtime.commits].find(
            (r) => r.environmentId === main,
        ) ?? runtime.latest
    );
};

/** A PR's other environment, as the "+N environments" hint lists it. */
export type PrOtherEnvironment = {
    environmentId: string;
    name: string;
    /** It starts a Run on each PR of this repository. */
    triggers: boolean;
    /** Its latest Run among the ones the answer carries. */
    run?: PrRunView;
};

/** The environments of the PR's repository besides the main one; empty for one environment. */
export const otherEnvironmentsOf = (
    runtime: PrRuntime,
): PrOtherEnvironment[] => {
    const all = runtime.environments ?? [];
    if (all.length < 2) return [];
    const main = runtime.environment?.environmentId;
    const runs = [
        ...(runtime.latest ? [runtime.latest] : []),
        ...runtime.commits,
    ];
    return all
        .filter((e) => e.environmentId !== main)
        .map((e) => {
            const run = runs.find((r) => r.environmentId === e.environmentId);
            return {
                environmentId: e.environmentId,
                name: e.name,
                triggers: e.triggers !== false,
                ...(run ? { run } : {}),
            };
        });
};

const environmentsOf = (runtime: PrRuntime): PrRuntimeEnvironment[] =>
    runtime.environments?.length
        ? runtime.environments
        : runtime.environment
          ? [runtime.environment]
          : [];

/** The environments "Run on this PR" (no environment named) starts a Run of. */
const triggeringOf = (runtime: PrRuntime) =>
    environmentsOf(runtime).filter((e) => e.triggers !== false);

/**
 * "Run on this PR" can start, as the API answers it (`canRequestRun`). An
 * answer without it: Kody Runtime is on, and an environment that runs this
 * repository's PRs is ready.
 */
export const canRequestRun = (runtime: PrRuntime): boolean =>
    typeof runtime.canRequestRun === "boolean"
        ? runtime.canRequestRun
        : triggeringOf(runtime).some((e) => e.on && e.ready);

/**
 * The repositories "Run on this PR" needs Create over: the PR's own and every
 * repository of each environment that runs its PRs, since the machine holds
 * all their code (the API checks each one).
 */
export const requestRunRepositoryIds = (runtime: PrRuntime): string[] => [
    ...new Set([
        runtime.repositoryId,
        ...triggeringOf(runtime).flatMap((e) => e.repositoryIds ?? []),
    ]),
];

/**
 * Why "Run on this PR" cannot start, in plain words, in the order the API
 * checks; undefined when it can, or without an environment.
 */
export const cannotRequestRunReason = (
    runtime: PrRuntime,
): string | undefined => {
    if (!environmentsOf(runtime).length || canRequestRun(runtime))
        return undefined;
    const triggering = triggeringOf(runtime);
    if (!triggering.length)
        return "No environment runs this repository's pull requests. Turn on triggers for it in one of its environments.";
    // An environment is on by its primary's mode: a member's own mode governs only the environment it is the primary of.
    if (!triggering.some((e) => e.on)) {
        const other = triggering.find(
            (e) =>
                e.role === "member" ||
                (e.repositoryIds?.length &&
                    e.repositoryIds[0] !== runtime.repositoryId),
        );
        return other
            ? `Kody Runtime is off for the environment of ${other.name}. Turn it on in ${other.name}'s Kody Runtime settings.`
            : "Kody Runtime is off for this repository.";
    }
    if (!triggering.some((e) => e.on && e.ready))
        return "The environment is not ready yet.";
    return undefined;
};

/** The Runtime column of one PR. */
export const prRuntimeCell = (
    runtime: PrRuntime,
    head?: { sha?: string | null; at?: string },
): PrRuntimeCell => {
    const run = mainRunOf(runtime);
    if (run) return runCell(run, staleRunSha(run, head));
    if (!runtime.environment) return { kind: "no_environment" };
    const reason = cannotRequestRunReason(runtime);
    return {
        kind: "not_run",
        canRequest: canRequestRun(runtime),
        ...(reason ? { reason } : {}),
    };
};

/** The name of the environment a Run ran in, among the PR's environments. */
export const environmentNameOf = (
    runtime: PrRuntime,
    environmentId: string,
): string | undefined =>
    [runtime.environment, ...(runtime.environments ?? [])].find(
        (e) => e?.environmentId === environmentId,
    )?.name;

/** One other environment's state, in a few words for the hint. */
export const otherEnvironmentWords = (other: PrOtherEnvironment): string => {
    if (other.run) return runVerdictWords(other.run).label;
    return other.triggers
        ? "not run yet"
        : "does not run this repository's PRs";
};

export const RUNTIME_FILTERS = [
    "regression",
    "no_regression",
    "could_not_boot",
    "not_run",
] as const;
export type RuntimeFilter = (typeof RUNTIME_FILTERS)[number];

export const RUNTIME_FILTER_LABEL: Record<RuntimeFilter, string> = {
    regression: "Regression",
    no_regression: "No regression",
    could_not_boot: "Could not boot",
    not_run: "Not run",
};

/** Which filter value a PR matches; a PR without an environment matches none. */
export const runtimeFilterOf = (
    cell: PrRuntimeCell | undefined,
): RuntimeFilter | undefined => {
    switch (cell?.kind) {
        case "regression":
            return "regression";
        case "clean":
            return "no_regression";
        case "could_not_boot":
            return "could_not_boot";
        case "not_run":
            return "not_run";
        default:
            return undefined;
    }
};

const TITLE_IN_SENTENCE = 60;
const VALUE_IN_SENTENCE = 40;

const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** `items[0].unit_price` → "Unit price". */
export const fieldWords = (path: string) => {
    const last =
        path
            .split(/[.[\]/]+/)
            .filter((part) => part !== "" && !/^\d+$/.test(part))
            .pop() ?? path;
    const words = last
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .trim()
        .toLowerCase();
    return words ? words[0].toUpperCase() + words.slice(1) : path;
};

const EMPTY_VALUES = new Set(['""', "''", "", "null", "[]", "{}"]);

/** A recorded value as words: "empty" for nothing, quotes off a string. */
export const valueWords = (value: string | undefined) => {
    if (value === undefined) return "missing";
    const v = value.trim();
    if (EMPTY_VALUES.has(v)) return "empty";
    const unquoted = /^"(.*)"$/.exec(v)?.[1] ?? v;
    return clip(unquoted, VALUE_IN_SENTENCE);
};

const titleOf = (first: PrRunFirstRegression) => {
    const raw = first.title?.trim().replace(/\.+$/, "");
    if (!raw) return first.boot ? "The app" : "A tested path";
    return clip(raw[0].toUpperCase() + raw.slice(1), TITLE_IN_SENTENCE);
};

/**
 * The first regression of a Run in one plain sentence: what Kody checked and
 * what differs, with both values. "Orders page: Quantity is empty on this
 * commit, 2 on main." Never a route, a method or a probe. `base` is the
 * Run's base branch (or its label); without one it says "base version",
 * never a guessed branch.
 */
export const regressionSentence = (
    first: PrRunFirstRegression,
    base?: string,
): string => {
    const baseLabel = baseVersionLabel({ baseBranch: base });
    const title = titleOf(first);
    if (first.boot)
        return `${title}: does not boot on this commit, boots on ${baseLabel}.`;
    if (first.destabilizes)
        return `${title}: the machine failed on this commit, stayed up on ${baseLabel}.`;
    const field = first.field;
    const body = (() => {
        if (field) {
            const name = fieldWords(field.path);
            if (field.base !== undefined && field.pr === undefined)
                return `${name} is missing on this commit, ${valueWords(field.base)} on ${baseLabel}`;
            if (field.base === undefined && field.pr !== undefined)
                return `${name} is new on this commit (${valueWords(field.pr)})`;
            return `${name} is ${valueWords(field.pr)} on this commit, ${valueWords(field.base)} on ${baseLabel}`;
        }
        const fields = first.differingFields.filter((f) => f !== "status");
        if (fields.length)
            return `${fieldWords(fields[0])} differs from ${baseLabel}${fields.length > 1 ? ` (and ${fields.length - 1} more)` : ""}`;
        return undefined;
    })();
    // A status that changed leads: it is the difference a reader weighs first; the body comes after.
    const status = first.status;
    if (status && status.base !== status.pr)
        return `${title}: ${status.base} on ${baseLabel}, ${status.pr} on this commit${body ? `; ${body}` : ""}.`;
    if (body) return `${title}: ${body}.`;
    return `${title}: answers differently than on ${baseLabel}.`;
};

/**
 * A finding of the Run page as the PR list reads its first regression
 * (libs/runtime/api/domain/pull-request-runs.ts firstRegressionOf): the same
 * purpose, first differing field and flags, so `regressionSentence` says the
 * same thing in both places.
 */
export const firstRegressionOfFinding = (finding: {
    purpose?: string;
    responseDiff?: ResponseDiff;
    differingFields?: readonly string[];
    base?: { rounds: readonly { status?: number }[] };
    pr?: { rounds: readonly { status?: number }[] };
    boot?: boolean;
    destabilizes?: boolean;
}): PrRunFirstRegression => {
    const baseStatus = finding.base?.rounds.find((r) => r.status !== undefined)?.status;
    const prStatus = finding.pr?.rounds.find((r) => r.status !== undefined)?.status;
    const title = finding.purpose?.trim();
    const field = finding.responseDiff?.fields.find(
        (f) => typeof f?.path === "string" && f.path !== "",
    );
    return {
        ...(title ? { title } : {}),
        ...(field
            ? {
                  field: {
                      path: field.path,
                      ...(typeof field.base === "string"
                          ? { base: field.base }
                          : {}),
                      ...(typeof field.pr === "string" ? { pr: field.pr } : {}),
                  },
              }
            : {}),
        differingFields: [...(finding.differingFields ?? [])],
        ...(baseStatus !== undefined && prStatus !== undefined && baseStatus !== prStatus ? { status: { base: baseStatus, pr: prStatus } } : {}),
        boot: !!finding.boot,
        destabilizes: !!finding.destabilizes,
    };
};

/** Only an http(s) address is ever a link: never `javascript:` or `data:` from a provider's answer. */
const webUrl = (raw: string | undefined): boolean => {
    if (!raw) return false;
    try {
        const { protocol } = new URL(raw);
        return protocol === "https:" || protocol === "http:";
    } catch {
        return false;
    }
};

/** A commit of the PR as the expanded row lists it. */
export type TimelineCommit<R> = {
    /** Absent for reviews that recorded no commit. */
    sha?: string;
    message?: string;
    at?: string;
    url?: string;
    /** The PR's head. */
    isHead: boolean;
    /** False for a commit no longer on the branch (a force push). */
    onBranch: boolean;
    /** The reviews that ran on it, newest first. */
    reviews: R[];
    /**
     * Those of its reviews that recorded no commit (a review that stopped
     * before reading the commits): placed on the commit that was the PR's
     * latest when they ran.
     */
    unrecordedReviews?: R[];
    /** Its latest Run. */
    run?: PrRunView;
};

export type TimelineRow<R> =
    | { kind: "commit"; commit: TimelineCommit<R> }
    | { kind: "collapsed"; commits: TimelineCommit<R>[] };

/** Below this many quiet commits in a row, they are listed, not folded. */
export const MIN_COLLAPSED_COMMITS = 2;

/**
 * The PR by commit, newest first: each commit with the reviews that ran on
 * it and its latest Run, matched by SHA. The branch's commits come first, in
 * the provider's order reversed; SHAs a review or a Run saw that are no
 * longer on the branch follow, newest first; reviews with no recorded commit
 * close the list. Runs of quiet commits (no review, no Run, not the head)
 * fold into one row. Without the branch's commits (still loading, or the
 * provider failed), `headSha` marks the head.
 */
export const buildCommitTimeline = <R>(input: {
    commits?: ReadonlyArray<{
        sha: string;
        message?: string;
        authoredAt?: string;
        htmlUrl?: string;
    }>;
    reviews: ReadonlyArray<{ sha?: string | null; at?: string; review: R }>;
    runs: ReadonlyArray<PrRunView>;
    headSha?: string | null;
}): TimelineRow<R>[] => {
    const bySha = new Map<string, TimelineCommit<R>>();
    const order: TimelineCommit<R>[] = [];
    const branch = input.commits ?? [];
    const knowsBranch = branch.length > 0;
    const head = knowsBranch
        ? branch[branch.length - 1].sha
        : (input.headSha ?? undefined);

    for (const c of [...branch].reverse()) {
        const key = c.sha.toLowerCase();
        if (bySha.has(key)) continue;
        const commit: TimelineCommit<R> = {
            sha: c.sha,
            ...(c.message ? { message: c.message.split("\n")[0] } : {}),
            ...(c.authoredAt ? { at: c.authoredAt } : {}),
            ...(webUrl(c.htmlUrl) ? { url: c.htmlUrl } : {}),
            isHead: sameSha(c.sha, head),
            onBranch: true,
            reviews: [],
        };
        bySha.set(key, commit);
        order.push(commit);
    }

    // SHAs a review or a Run saw that the branch list does not have.
    const extra: TimelineCommit<R>[] = [];
    const seenAt = new Map<TimelineCommit<R>, number>();
    const commitOf = (sha: string, at: string | undefined) => {
        const key = sha.toLowerCase();
        let commit = bySha.get(key);
        if (!commit) {
            commit = {
                sha,
                isHead: sameSha(sha, head),
                onBranch: !knowsBranch,
                reviews: [],
            };
            bySha.set(key, commit);
            extra.push(commit);
            seenAt.set(commit, 0);
        }
        const t = at ? Date.parse(at) : NaN;
        const prev = seenAt.get(commit);
        if (prev !== undefined && Number.isFinite(t))
            seenAt.set(commit, Math.max(prev, t));
        return commit;
    };

    // A review that recorded no commit ran on the PR's latest commit at the
    // time: the newest branch commit authored before it, else the head.
    const dated = branch
        .map((c) => ({
            sha: c.sha,
            t: c.authoredAt ? Date.parse(c.authoredAt) : NaN,
        }))
        .filter((c) => Number.isFinite(c.t));
    const latestAt = (at: string | undefined) => {
        const t = at ? Date.parse(at) : NaN;
        if (!Number.isFinite(t)) return undefined;
        let best: { sha: string; t: number } | undefined;
        for (const c of dated)
            if (c.t <= t && (!best || c.t >= best.t)) best = c;
        return best?.sha;
    };
    const unrecorded: R[] = [];
    for (const r of input.reviews) {
        if (r.sha) {
            commitOf(r.sha, r.at).reviews.push(r.review);
            continue;
        }
        const sha = latestAt(r.at) ?? head;
        if (!sha) {
            unrecorded.push(r.review);
            continue;
        }
        const commit = commitOf(sha, r.at);
        commit.reviews.push(r.review);
        (commit.unrecordedReviews ??= []).push(r.review);
    }
    // `runs` is newest first: the first Run of a SHA is its latest.
    for (const run of input.runs) {
        const commit = commitOf(run.headSha, run.requestedAt);
        if (!commit.run) commit.run = run;
    }

    extra.sort((a, b) => (seenAt.get(b) ?? 0) - (seenAt.get(a) ?? 0));
    const all: TimelineCommit<R>[] = [
        ...order,
        ...extra,
        ...(unrecorded.length
            ? [
                  {
                      isHead: false,
                      onBranch: true,
                      reviews: unrecorded,
                      unrecordedReviews: unrecorded,
                  },
              ]
            : []),
    ];

    const rows: TimelineRow<R>[] = [];
    let quiet: TimelineCommit<R>[] = [];
    const flush = () => {
        if (quiet.length >= MIN_COLLAPSED_COMMITS)
            rows.push({ kind: "collapsed", commits: quiet });
        else for (const c of quiet) rows.push({ kind: "commit", commit: c });
        quiet = [];
    };
    for (const c of all) {
        if (!c.isHead && c.reviews.length === 0 && !c.run) {
            quiet.push(c);
            continue;
        }
        flush();
        rows.push({ kind: "commit", commit: c });
    }
    flush();
    return rows;
};

/** The chip words of one Run's verdict, for the PR page card. */
export const runVerdictWords = (
    run: PrRunView,
): { label: string; tone: Tone } => {
    const cell = runCell(run);
    switch (cell.kind) {
        case "regression":
            return {
                label: `${cell.count} regression${cell.count === 1 ? "" : "s"}`,
                tone: "danger",
            };
        case "clean":
            return { label: "No regression", tone: "success" };
        case "running":
            return { label: `Running · ${cell.label}`, tone: "info" };
        case "could_not_boot":
            return {
                label: `Could not boot${cell.where ? ` · ${cell.where}` : ""}`,
                tone: "warning",
            };
        case "other":
            return { label: cell.label, tone: cell.tone };
    }
};

/** How many Runs "Run on this PR" queued: one, or one per environment that runs the PR. */
export const queuedRunCount = (answer: unknown) => {
    const runs = (answer as { runs?: unknown } | null | undefined)?.runs;
    return Array.isArray(runs) ? Math.max(1, runs.length) : 1;
};
