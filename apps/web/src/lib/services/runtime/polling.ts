import type {
    RunPublication,
    RunState,
    RuntimeEnvironment,
    RuntimeEnvironmentStatus,
} from "./contracts";
import { isTerminalRunState } from "./labels";
import { isEnvironmentBusy } from "./model/environment";

// When the Runtime queries refetch on their own. Every interval stops once
// nothing can move any more, and backs off when something is live but quiet,
// so a forgotten tab does not hammer the API (the proxy limits 120 req/10 s).

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Doubles from `base` per failed fetch, up to `max`. */
export const backoffMs = (base: number, failures: number, max: number) =>
    Math.min(max, base * 2 ** Math.max(0, failures));

const ageMs = (at: string | undefined, now: number) => {
    const t = at ? Date.parse(at) : NaN;
    return Number.isFinite(t) ? Math.max(0, now - t) : 0;
};

/**
 * How long after a Run ends the page keeps asking whether its result reached
 * the PR: the product re-drives a lost publication for about 15 minutes.
 */
export const PUBLICATION_WATCH_MS = 30 * MINUTE;

/**
 * How long a Run this browser just started ("Run again", "Run on this PR",
 * a simulation) may be unknown to the API: the worker records it through
 * the outbox, a few seconds after the start answered. Past this, the page
 * says it was not found.
 */
export const NEW_RUN_GRACE_MS = MINUTE;

/**
 * A Run started at `startedAt` that the API does not know yet is still being
 * recorded while its last answer (`answeredAt`) came within the grace. An id
 * nobody started here (`startedAt` absent) is simply not found.
 */
export const isRunBeingRecorded = (
    startedAt: number | undefined,
    answeredAt: number,
) => startedAt !== undefined && answeredAt - startedAt < NEW_RUN_GRACE_MS;

/** Every Run a start answered: one, or one per environment that runs the PR. */
export const startedRunIdsOf = (
    answer:
        | { runId?: string; runs?: ReadonlyArray<{ runId?: string }> }
        | null
        | undefined,
): string[] => {
    const ids = [answer?.runId, ...(answer?.runs ?? []).map((r) => r.runId)];
    return [...new Set(ids.filter((id): id is string => !!id))];
};

/**
 * One Run's projection. The stream refreshes it on each state event; this is
 * the fallback for when the stream is down or slow: 5 s while the Run moved
 * in the last minute, then slower, at most once a minute. Once terminal, it
 * polls every 15 s only while the result is not settled on the PR yet. A Run
 * this browser just started and the API does not know yet (`null`) is asked
 * for every 2 s until it is recorded, for a minute at most.
 */
export const runRefetchInterval = (
    run:
        | {
              state: RunState;
              updatedAt?: string;
              finishedAt?: string;
              publication?: Pick<RunPublication, "settled">;
          }
        | null
        | undefined,
    opts: {
        now: number;
        failures?: number;
        /** When this browser started the Run, if it did. */
        startedAt?: number;
        /** When the last answer came; `now` when absent. */
        answeredAt?: number;
        /**
         * The page follows the Run's stream, which refreshes the Run on each
         * state and verdict event: the poll is only a fallback then (WP7).
         */
        streamLive?: boolean;
    },
): number | false => {
    if (!run)
        return run === null &&
            isRunBeingRecorded(opts.startedAt, opts.answeredAt ?? opts.now)
            ? backoffMs(2 * SECOND, opts.failures ?? 0, 10 * SECOND)
            : false;
    if (isTerminalRunState(run.state)) {
        const unsettled = run.publication && !run.publication.settled;
        const recent =
            ageMs(run.finishedAt ?? run.updatedAt, opts.now) < PUBLICATION_WATCH_MS;
        return unsettled && recent
            ? backoffMs(15 * SECOND, opts.failures ?? 0, MINUTE)
            : false;
    }
    if (opts.streamLive) return MINUTE;
    const quiet = ageMs(run.updatedAt, opts.now);
    const base =
        quiet < MINUTE
            ? 5 * SECOND
            : quiet < 10 * MINUTE
              ? 15 * SECOND
              : MINUTE;
    return backoffMs(base, opts.failures ?? 0, MINUTE);
};

/** A live Run older than this is stuck, not running: the list stops asking about it. */
export const LIVE_RUN_WATCH_MS = 6 * 60 * MINUTE;

/**
 * A list of Runs moves on its own while one of them is live: every 10 s
 * while the newest live Run is recent, slower as it ages, and not at all once
 * it is older than any Run lasts (the stuck detector ends it server-side).
 */
export const runsListRefetchInterval = (
    runs:
        | Array<{
              state: RunState;
              requestedAt?: string;
              startedAt?: string;
              updatedAt?: string;
          }>
        | null
        | undefined,
    opts: { failures?: number; now?: number } = {},
): number | false => {
    const live = (runs ?? []).filter((run) => !isTerminalRunState(run.state));
    if (!live.length) return false;
    const now = opts.now ?? Date.now();
    const youngest = Math.min(
        ...live.map((run) =>
            ageMs(run.updatedAt ?? run.startedAt ?? run.requestedAt, now),
        ),
    );
    if (youngest >= LIVE_RUN_WATCH_MS) return false;
    const base =
        youngest < 10 * MINUTE
            ? 10 * SECOND
            : youngest < 60 * MINUTE
              ? 30 * SECOND
              : MINUTE;
    return backoffMs(base, opts.failures ?? 0, MINUTE);
};

/**
 * A preview card: a side that is starting is read every 4 s, an open one
 * (ready, sleeping or blocked) once a minute so a sleep or an expiry shows
 * up, and nothing once no preview is open.
 */
export const previewCardRefetchInterval = (
    previews: Array<{ state: string } | undefined>,
): number | false => {
    if (previews.some((p) => p?.state === "starting")) return 4 * SECOND;
    return previews.some(
        (p) =>
            p?.state === "ready" ||
            p?.state === "sleeping" ||
            p?.state === "blocked",
    )
        ? MINUTE
        : false;
};

/** A setup older than this is treated as stuck: polled once a minute only. */
export const STUCK_SETUP_MS = 15 * MINUTE;

/** Since the last sign of life: the setup record or the request on the product row. */
const setupAge = (
    env: Pick<RuntimeEnvironment, "setup" | "updatedAt">,
    now: number,
) => {
    const ages = [env.setup?.updatedAt, env.updatedAt]
        .filter((at): at is string => !!at)
        .map((at) => ageMs(at, now));
    // No timestamp at all: treat it as moving rather than stuck.
    return ages.length ? Math.min(...ages) : 0;
};

/**
 * Environments while a setup is requested or running: 3 s, slower after a
 * failed fetch, once a minute when the setup has not moved for 15 minutes.
 */
export const environmentsRefetchInterval = (
    envs:
        | Array<Pick<RuntimeEnvironment, "state" | "setup" | "updatedAt">>
        | null
        | undefined,
    opts: { now: number; failures?: number },
): number | false => {
    const busy = (envs ?? []).filter((e) => isEnvironmentBusy(e));
    if (busy.length === 0) return false;
    const moving = busy.some((e) => setupAge(e, opts.now) < STUCK_SETUP_MS);
    return moving ? backoffMs(3 * SECOND, opts.failures ?? 0, MINUTE) : MINUTE;
};

type WatchedEnvironment = Pick<RuntimeEnvironmentStatus, "environmentId" | "state"> & {
    setup?: Pick<NonNullable<RuntimeEnvironmentStatus["setup"]>, "state" | "updatedAt"> & {
        progress?: { updatedAt?: string };
    };
};

/**
 * What moves while a setup runs: the state, the setup's state and time, and,
 * with `progress`, its live progress while it sets up (the worker records it
 * every few seconds while a boot advances).
 */
const setupSignature = (env: WatchedEnvironment, progress: boolean) =>
    [
        env.state ?? "",
        env.setup?.state ?? "",
        env.setup?.updatedAt ?? "",
        progress && env.setup?.state === "setting_up" ? (env.setup.progress?.updatedAt ?? "") : "",
    ].join("|");

/**
 * The environments whose status (GET /runtime/environments/status) says
 * something moved since the views on screen were read: those views are read
 * again, the others are not. With `complete` (the views are the whole list),
 * an environment the list does not show yet counts as moved too. With
 * `progress: false` (a screen that shows no live progress, as the list), a
 * progress tick alone is not a move.
 */
export const changedEnvironmentIds = (
    shown: ReadonlyArray<WatchedEnvironment> | null | undefined,
    statuses: ReadonlyArray<WatchedEnvironment> | null | undefined,
    opts: { complete: boolean; progress?: boolean },
): string[] => {
    const byId = new Map((shown ?? []).map((e) => [e.environmentId, e]));
    const progress = opts.progress ?? true;
    return (statuses ?? [])
        .filter((s) => {
            const view = byId.get(s.environmentId);
            return view ? setupSignature(view, progress) !== setupSignature(s, progress) : opts.complete;
        })
        .map((s) => s.environmentId);
};
