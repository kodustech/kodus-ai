import type { EnvironmentSetupState, RuntimeRunProjection } from '@libs/runtime/run';

// The Runs of a page of pull requests, as the pull requests screens read them:
// per PR its latest Run and the latest Run of each commit, in one read. The
// screens never ask once per PR.

export const RUNTIME_PULL_REQUEST_RUNS_READER = Symbol.for('RuntimeApi.PullRequestRunsReader');

/** At most this many pull requests in one read. */
export const MAX_PULL_REQUESTS_PER_READ = 100;
/** At most this many commits carry their own Run in the answer. */
export const MAX_COMMITS_PER_PULL_REQUEST = 20;

export interface PullRequestRef {
    repositoryId: string;
    prNumber: number;
}

/** The projection fields this read needs; everything else stays in the store. */
export type PullRequestRunRecord = Pick<
    RuntimeRunProjection,
    'runId' | 'attempt' | 'organizationId' | 'repositoryId' | 'prNumber' | 'headSha' | 'environmentId' | 'state' | 'requestedAt'
> &
    Partial<
        Pick<
            RuntimeRunProjection,
            'baseBranch' | 'verdictState' | 'phase' | 'startedAt' | 'finishedAt' | 'findings' | 'probes' | 'bootFailure'
        >
    > & {
        /** Only what each probe set out to check; the specs stay in the store. */
        reproduction?: { probes: Array<{ probeId: string; purpose: string }> };
    };

export interface PullRequestRunsReader {
    /**
     * The latest Run of each commit of these pull requests of one org, newest
     * first, at most `perPullRequest` commits each, in one query. A pull
     * request of another org matches nothing.
     */
    listForPullRequests(input: {
        organizationId: string;
        pullRequests: PullRequestRef[];
        perPullRequest: number;
    }): Promise<PullRequestRunRecord[]>;
    /** The setup state of each of these environments of one org, in one query. */
    setupStates(organizationId: string, environmentIds: string[]): Promise<Map<string, EnvironmentSetupState>>;
}

/** One field that answers differently, as the response diff recorded it (redacted, cut). */
export interface DifferingFieldView {
    path: string;
    base?: string;
    pr?: string;
}

/** The first regression of a Run, as the list says it in plain words. */
export interface FirstRegressionView {
    /** What the probe set out to check, as Kody wrote it; absent when the Run kept no reproduction. */
    title?: string;
    /** The first field that differs, with both values. */
    field?: DifferingFieldView;
    differingFields: string[];
    /** This PR does not boot while main does. */
    boot: boolean;
    /** The machine itself failed on this PR. */
    destabilizes: boolean;
}

export interface PullRequestRunView {
    runId: string;
    attempt: number;
    headSha: string;
    baseBranch?: string;
    environmentId: string;
    state: RuntimeRunProjection['state'];
    verdictState?: RuntimeRunProjection['verdictState'];
    phase?: string;
    requestedAt: string;
    startedAt?: string;
    finishedAt?: string;
    /** Findings Kody measured that nobody marked intended, errors on new endpoints aside. */
    regressions: number;
    /** 5xx on an endpoint the PR adds (`new_endpoint_error`), not marked intended; absent when none. The Run still fails. */
    newEndpointErrors?: number;
    /** Probes the Run sent. */
    probes: number;
    /** The side that did not boot, when one did not. */
    bootFailureSide?: 'base' | 'pr';
    firstRegression?: FirstRegressionView;
}

export interface PullRequestEnvironmentView {
    environmentId: string;
    /** The environment's repository name. */
    name: string;
    /** Its setup finished: a Run can start on it. */
    ready: boolean;
    /** Kody Runtime is not `off` for the environment: its primary's mode (a member's own mode governs only its own environment). */
    on: boolean;
    /** Only when the repository is in several environments: its place in this one. */
    role?: 'primary' | 'member';
    /** A PR of the repository starts a Run of this environment ("Run on this PR" without an environment runs only there). */
    triggers?: boolean;
    /** Every repository the environment holds, the primary first: starting a Run of it needs Create over each one. */
    repositoryIds: string[];
}

export interface PullRequestRunsView {
    repositoryId: string;
    prNumber: number;
    environment: PullRequestEnvironmentView | null;
    /** Every environment the repository is part of that the caller may read, when there are several. */
    environments?: PullRequestEnvironmentView[];
    /**
     * Whether "Run on this PR" (no environment named) can start a Run: an
     * environment that triggers on the repository is ready, Kody Runtime is on
     * for it and not off for another repository of that environment. A Run
     * already live on the head, the fork policy and the daily count are
     * checked when asked.
     */
    canRequestRun: boolean;
    latest: PullRequestRunView | null;
    /** The latest Run of each commit, newest first. */
    commits: PullRequestRunView[];
}

const TITLE_MAX = 120;
const VALUE_MAX = 80;

const cut = (value: string | undefined, max: number) => (typeof value === 'string' ? value.slice(0, max) : undefined);

type Probe = NonNullable<RuntimeRunProjection['findings']>[number];

/** A finding nobody marked intended: a regression, or an error on an endpoint the PR adds. */
const isUnintendedFinding = (p: Probe) => p.verdict === 'finding' && p.intent !== 'intended';
const isNewEndpointError = (p: Probe) => p.findingKind === 'new_endpoint_error';

const firstRegressionOf = (run: PullRequestRunRecord, regressions: Probe[]): FirstRegressionView | undefined => {
    const first = regressions[0];
    if (!first) return undefined;
    const purpose = run.reproduction?.probes.find((p) => p.probeId === first.probeId)?.purpose;
    const field = first.responseDiff?.fields.find((f) => typeof f?.path === 'string' && f.path !== '');
    return {
        ...(purpose ? { title: cut(purpose.trim(), TITLE_MAX) } : {}),
        ...(field
            ? {
                  field: {
                      path: cut(field.path, VALUE_MAX)!,
                      ...(typeof field.base === 'string' ? { base: cut(field.base, VALUE_MAX) } : {}),
                      ...(typeof field.pr === 'string' ? { pr: cut(field.pr, VALUE_MAX) } : {}),
                  },
              }
            : {}),
        differingFields: (first.differingFields ?? []).slice(0, 5).map((f) => cut(f, VALUE_MAX)!),
        boot: first.entryPoint === 'boot' && first.findingKind === 'pr_destabilizes_machine',
        destabilizes: first.findingKind === 'pr_destabilizes_machine',
    };
};

/** One Run as the pull requests screens show it: counts and the first regression, no probe detail. */
export function pullRequestRunView(run: PullRequestRunRecord): PullRequestRunView {
    // The same finding can sit in `findings` and in `probes`: count it once.
    const byKey = new Map<string, Probe>();
    for (const p of [...(run.findings ?? []), ...(run.probes ?? [])]) {
        if (isUnintendedFinding(p)) byKey.set(`${p.probeId}::${p.entryPoint}`, p);
    }
    // A 5xx on a route the PR adds is no regression (main never had the route): counted apart, as the Run page shows it.
    const regressions = [...byKey.values()].filter((p) => !isNewEndpointError(p));
    const newEndpointErrors = byKey.size - regressions.length;
    const firstRegression = firstRegressionOf(run, regressions);
    const side = run.bootFailure?.side;
    return {
        runId: run.runId,
        attempt: run.attempt,
        headSha: run.headSha,
        ...(run.baseBranch === undefined ? {} : { baseBranch: run.baseBranch }),
        environmentId: run.environmentId,
        state: run.state,
        ...(run.verdictState === undefined ? {} : { verdictState: run.verdictState }),
        ...(run.phase === undefined ? {} : { phase: run.phase }),
        requestedAt: run.requestedAt,
        ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
        ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
        regressions: regressions.length,
        ...(newEndpointErrors > 0 ? { newEndpointErrors } : {}),
        probes: run.probes?.length ?? 0,
        ...(side === 'base' || side === 'pr' ? { bootFailureSide: side } : {}),
        ...(firstRegression ? { firstRegression } : {}),
    };
}

export const pullRequestKey = (repositoryId: string, prNumber: number) => `${repositoryId}#${prNumber}`;

/**
 * Groups Runs (any order) by pull request: the latest Run, and the latest Run
 * of each commit, both newest first by request time.
 */
export function groupPullRequestRuns(runs: PullRequestRunRecord[]): Map<string, { latest: PullRequestRunView; commits: PullRequestRunView[] }> {
    const sorted = [...runs].sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : a.requestedAt > b.requestedAt ? -1 : 0));
    const out = new Map<string, { latest: PullRequestRunView; commits: PullRequestRunView[]; seen: Set<string> }>();
    for (const run of sorted) {
        const key = pullRequestKey(run.repositoryId, run.prNumber);
        let entry = out.get(key);
        if (!entry) {
            const view = pullRequestRunView(run);
            entry = { latest: view, commits: [], seen: new Set() };
            out.set(key, entry);
        }
        if (entry.seen.has(run.headSha) || entry.commits.length >= MAX_COMMITS_PER_PULL_REQUEST) continue;
        entry.seen.add(run.headSha);
        entry.commits.push(entry.commits.length === 0 ? entry.latest : pullRequestRunView(run));
    }
    return new Map([...out].map(([key, { latest, commits }]) => [key, { latest, commits }]));
}
