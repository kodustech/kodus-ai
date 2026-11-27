import type {
    RuntimeEnvironmentSuite,
    RuntimeSuiteFailure,
    RuntimeSuiteFailureGroup,
    RuntimeSuiteRun,
    RuntimeSuiteSpec,
    RuntimeSuiteUsage,
} from "../contracts";
import { formatDurationMs, shortSha } from "../format";
import type { Tone } from "../labels";

// What the e2e suite screens say (docs/runtime/e2e-suites.md section 13): the Run page's tab, Settings and the Usage line. The API
// answers structured fields; every sentence is written here. A field the run did not store is said to be absent, never filled in.

const plural = (n: number, one: string, many = `${one}s`) =>
    `${n} ${n === 1 ? one : many}`;
const minutes = (ms: number) => Math.round(ms / 60_000);
/** `e2e/checkout.spec.ts` → `checkout.spec.ts` */
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Why the whole suite ran, as a clause: "The whole suite ran: …" and "Why all N specs". */
/** Keyed by the Runtime's `FullReason` (a parity spec holds the keys to libs/runtime/suite/select.ts). */
export const FULL_REASON_TEXT: Record<string, string> = {
    manifest: "a dependency manifest changed",
    lockfile: "a lockfile changed",
    config: "a test runner, build or compose configuration changed",
    shared_routing: "shared routing or setup code changed",
    uncovered_file:
        "a changed file is exercised by no spec, so Kody runs every spec rather than guess",
    map_missing: "Kody has not yet learned which code each spec exercises, so it cannot pick only the specs this change affects",
    changes_unknown: "the files this pull request changes could not be read",
    map_stale: "what Kody learned about which code each spec exercises is too old to trust",
    map_digest: "the suite changed since Kody last learned which code each spec exercises",
    noise_file: "a changed file is exercised by most specs",
    ready_for_review: "the pull request is ready for review",
    baseline: "this is the baseline on main",
    shadow: "this run double-checks the specs Kody picks",
    selection_miss:
        "a recent double-check caught a failing spec Kody had skipped, so every spec runs for a while",
    selection_off: "spec selection is off for this environment",
    huge_diff:
        "this pull request changes too many files for Kody to trust what it learned about which code each spec exercises",
    no_main_pass:
        "Kody has not yet seen these specs pass on main, so it cannot tell which ones are safe to skip",
};

const reasonText = (reason: string | undefined) =>
    reason
        ? (FULL_REASON_TEXT[reason] ?? reason.replace(/_/g, " "))
        : undefined;

const times = (n: number) =>
    n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;

/** "1 test was already failing on main and 1 is flaky; neither blocks." Empty when there is neither. */
const noiseSentence = (preExisting: number, flaky: number): string => {
    const parts = [
        preExisting > 0
            ? `${plural(preExisting, "test")} ${preExisting === 1 ? "was" : "were"} already failing on main`
            : undefined,
        flaky > 0
            ? `${preExisting > 0 ? flaky : plural(flaky, "test")} ${flaky === 1 ? "is" : "are"} flaky`
            : undefined,
    ].filter((x): x is string => !!x);
    if (!parts.length) return "";
    const total = preExisting + flaky;
    return `${parts.join(" and ")}; ${total === 1 ? "it does not block" : total === 2 ? "neither blocks" : "none of them blocks"}.`;
};

export type SuiteVerdict = { tone: Tone; title: string; sentence: string };

/** The banner on top of the tab: one sentence about the outcome, from the run's counts and its first regression. */
export const suiteVerdict = (run: RuntimeSuiteRun): SuiteVerdict => {
    const { regression, preExisting, flaky, unclassified } = run.classes;
    if (run.state === "requested" || run.state === "running")
        return {
            tone: "info",
            title: "Running",
            sentence:
                "Kody is running this repository's e2e suite. The results appear here as it finishes.",
        };
    if (run.state === "timed_out")
        return {
            tone: "warning",
            title: "Timed out",
            sentence:
                "The suite ran out of time before every spec reported. The specs that did are below.",
        };
    if (run.state === "cancelled")
        return {
            tone: "neutral",
            title: "Cancelled",
            sentence:
                "A newer push or a closed pull request stopped this suite.",
        };
    if (run.state === "errored")
        return {
            tone: "danger",
            title: "Could not finish",
            sentence:
                "The suite stopped before it could report. Run the failed specs again.",
        };
    const noise = noiseSentence(preExisting, flaky);
    if (regression > 0) {
        const first = run.failures.find((f) => f.group === "regression");
        const lead =
            regression === 1 && first
                ? `${baseName(first.spec)} › ${first.title} ${first.main?.outcome === "passed" ? "passes on main and fails" : "fails"} on this PR, ${times(first.pr.failed)}.`
                : `${plural(regression, "test")} pass on main and fail on this PR.`;
        return {
            tone: "danger",
            title: `${plural(regression, "regression")}, the check failed`,
            sentence: [lead, noise].filter(Boolean).join(" "),
        };
    }
    if (unclassified > 0 || run.state === "neutral") {
        const failed = run.state === "failed";
        return {
            tone: failed ? "danger" : "warning",
            title:
                unclassified > 0
                    ? `${plural(unclassified, "failure")} could not be classified, the check ${failed ? "failed" : "is neutral"}`
                    : "Not everything could be run",
            sentence: failed
                ? "The gate is strict: anything the re-runs could not settle fails the check."
                : "The re-runs could not say whether the PR caused them, so the check does not fail.",
        };
    }
    return {
        tone: "success",
        title: `No regressions, ${plural(run.totals.passed, "spec")} passed`,
        sentence: noise || "Every spec that ran passed.",
    };
};

export type SuiteFact = {
    label: string;
    value: string;
    hint: string;
    mono?: boolean;
};

/** The four key facts under the banner. */
export const suiteFacts = (run: RuntimeSuiteRun): SuiteFact[] => {
    const s = run.selection;
    const why =
        s.mode === "selected"
            ? "Selected by coverage of the diff"
            : s.mode === "none"
              ? "No spec is reached by this change"
              : s.reason
                ? `The whole suite ran: ${reasonText(s.reason)}`
                : "The whole suite ran";
    const drift = run.baseDrift;
    return [
        {
            label: "Specs run",
            value: `${run.specs.ran} of ${run.specs.total}`,
            hint: why,
        },
        {
            label: "Duration",
            value: formatDurationMs(run.durationMs),
            hint:
                run.hosts === 1
                    ? "1 host"
                    : `${run.hosts} hosts, one shard each`,
        },
        {
            label: "Compared against",
            value: `main ${shortSha(run.mainSha)}`,
            hint:
                drift === undefined
                    ? "How far behind main was not compared"
                    : drift === 0
                      ? "Merge base is main"
                      : `Merge base, ${plural(drift, "commit")} behind main`,
            mono: true,
        },
        run.machine
            ? {
                  label: "Machine time",
                  value: `${minutes(run.machine.firstPassMs + run.machine.rerunMs)} min`,
                  hint: `First pass ${minutes(run.machine.firstPassMs)} · re-runs ${minutes(run.machine.rerunMs)}`,
              }
            : run.state === "requested" || run.state === "running"
              ? {
                    label: "Machine time",
                    value: "Measured when the suite ends",
                    hint: "The suite is still running",
                }
              : {
                  label: "Machine time",
                  value: "Not recorded",
                  hint: "This run was stored before machine time was measured",
              },
    ];
};

const GROUPS: Array<{
    group: RuntimeSuiteFailureGroup;
    label: string;
    tone: Tone;
}> = [
    { group: "regression", label: "Regression", tone: "danger" },
    { group: "unclassified", label: "Unclassified", tone: "alert" },
    {
        group: "pre_existing",
        label: "Already failing on main",
        tone: "warning",
    },
    { group: "flaky", label: "Flaky", tone: "info" },
];

/** The failed tests by whose fault they are; a group with none is left out. */
export const failureGroups = (run: RuntimeSuiteRun) =>
    GROUPS.map((g) => ({
        ...g,
        items: run.failures.filter((f) => f.group === g.group),
    })).filter((g) => g.items.length > 0);

export const attemptsLine = (pr: RuntimeSuiteFailure["pr"]) =>
    pr.attempts === 0
        ? "no attempt recorded"
        : `failed ${pr.failed} of ${pr.attempts}`;

export const mainLine = (f: RuntimeSuiteFailure): string => {
    if (!f.main) return "not run for this test";
    if (f.main.outcome === "passed") return "passed";
    if (f.main.outcome === "not_run") return "not run";
    return f.main.sameError
        ? "failed, the same error"
        : "failed, with another error";
};

/** What a kept file is, by its name. */
export const artifactLabel = (name: string): string => {
    const lower = name.toLowerCase();
    if (lower.endsWith(".zip") || lower.includes("trace")) return "Trace";
    if (/\.(png|jpe?g)$/.test(lower)) return "Screenshot";
    if (/\.(webm|mp4)$/.test(lower)) return "Video";
    if (lower.endsWith(".log") || lower.endsWith(".txt")) return "Log tail";
    return name;
};

const WHY_NOTE =
    "Usually Kody runs only the specs a change can affect, from what full runs on main taught it about which code each spec exercises. It runs every spec when dependencies or test configuration change, when it has not learned that yet, or right after it caught a spec it should have run.";

export type WhySpecs = {
    title: string;
    summary: string;
    rows: Array<{ file: string; specs: string }>;
    note?: string;
};

/** "Why these N specs": the changed file → specs map the run stored, or the reason the whole suite ran. */
export const whySpecs = (run: RuntimeSuiteRun): WhySpecs => {
    const s = run.selection;
    if (s.mode === "full")
        return {
            title: `Why all ${run.specs.total} specs`,
            summary: reasonText(s.reason) ?? "the whole suite ran",
            rows: [],
            note: WHY_NOTE,
        };
    const title = `Why these ${run.specs.ran} specs`;
    const rows = Object.entries(s.reachedBy ?? {}).map(([file, specs]) => ({
        file,
        specs: specs.map(baseName).join(", "),
    }));
    if (rows.length === 0)
        return {
            title,
            summary:
                s.mode === "none"
                    ? "no spec is reached by this change"
                    : "which changed file reached which spec was not recorded for this run",
            rows,
            note: WHY_NOTE,
        };
    return {
        title,
        summary: `picked from ${plural(rows.length, "changed file")}`,
        rows,
        note: WHY_NOTE,
    };
};

const GATE_TEXT = {
    default: "Neutral: only a confirmed regression fails the check",
    strict: "Strict: anything unconfirmed fails the check too",
} as const;

const RUNNER_NAME: Record<string, string> = {
    playwright: "Playwright",
    cypress: "Cypress",
};

/** Why the environment has no baseline on main: what became of the newest one asked for, in words. */
export const noBaselineText = (
    request: RuntimeEnvironmentSuite["baselineRequest"],
): string => {
    if (!request) return "Waiting for the main template to be built";
    const at = shortSha(request.sha);
    if (request.state === "queued") return `Queued for ${at}, not started yet`;
    if (request.state === "started") return `Running on ${at}`;
    if (request.state === "superseded")
        return `${at} was replaced by a newer main commit before it ran`;
    return `No suite declared at ${at}, so no baseline ran`;
};

/** "From the recipe": what `.kodus/workspace.yaml` says, read only (the file is where it is edited). */
export const environmentSuiteFacts = (
    suite: RuntimeEnvironmentSuite,
): Array<{ label: string; value: string; mono?: boolean }> => {
    const r = suite.recipe;
    if (!r) return [];
    const base = suite.lastBaseline;
    return [
        { label: "Runner", value: RUNNER_NAME[r.runner] ?? r.runner },
        {
            label: "Specs",
            value: base
                ? `${r.specs} · ${plural(base.specs, "file")}`
                : r.specs,
            mono: true,
        },
        { label: "Command", value: r.command, mono: true },
        ...(r.results
            ? [{ label: "Results", value: r.results, mono: true }]
            : []),
        {
            label: "Last baseline on main",
            value: base
                ? `${shortSha(base.sha)} · ${base.passed} passed, ${base.failed} failed`
                : noBaselineText(suite.baselineRequest),
        },
        {
            label: "Maximum hosts per run",
            value:
                r.shards !== undefined
                    ? String(r.shards)
                    : "Up to the recipe's default",
        },
        {
            label: "When a failure cannot be classified",
            value: GATE_TEXT[r.gate],
        },
    ];
};

/** The "selection paused" banner: shown only while the shadow check's brake holds; a person's own switch is just the switch. */
export const selectionBanner = (
    selection: RuntimeEnvironmentSuite["selection"],
): { title: string; body: string } | undefined => {
    const brake = selection.brake;
    if (!brake) return undefined;
    if (brake.off)
        return {
            title: "Spec selection is paused until you resume it",
            body: "The shadow check found failures the selection had skipped. Until you resume it, every pull request runs the whole suite.",
        };
    const miss = brake.miss
        ? `The shadow check ran the whole suite for PR #${brake.miss.prNumber} and found a failure the selection had skipped (${brake.miss.specs.join(", ")}). `
        : "The shadow check found a failure the selection had skipped. ";
    return {
        title: `Spec selection is paused for the next ${brake.fullPrsLeft === 1 ? "pull request" : `${brake.fullPrsLeft} pull requests`}`,
        body: `${miss}Until then every pull request runs the whole suite.`,
    };
};

const KIND_TEXT: Record<
    RuntimeSuiteUsage["lines"][number]["kind"],
    { label: string; what: string }
> = {
    pr: { label: "PR", what: "First pass on each pull request" },
    baseline: { label: "Baseline", what: "Whole suite on main, with coverage" },
    rerun: {
        label: "Re-run",
        what: "Failed specs again, on the PR and on main",
    },
    shadow: {
        label: "Shadow",
        what: "Whole suite in the background to check selection",
    },
};

const grouped = (n: number) => n.toLocaleString("en-US");

/** The Usage screen's e2e suite table: a line per kind. Minutes a run never measured are "Not measured", never zero. */
export const suiteUsageLines = (usage: RuntimeSuiteUsage) => {
    const measured = usage.lines.filter((l) => l.minutes !== null);
    return {
        rows: usage.lines.map((l) => ({
            kind: l.kind,
            ...KIND_TEXT[l.kind],
            runs: grouped(l.runs),
            minutes: l.minutes === null ? "Not measured" : grouped(l.minutes),
            minutesValue: l.minutes,
        })),
        totalMinutes: measured.length
            ? measured.reduce((n, l) => n + (l.minutes ?? 0), 0)
            : undefined,
        saved: usage.saved
            ? `In the ${usage.saved.shadowedRuns} selected runs a full shadow run also covered, selection saved ${grouped(usage.saved.minutes)} minutes.`
            : undefined,
        caveat:
            usage.unmeasuredRuns > 0
                ? `${plural(usage.unmeasuredRuns, "run")} ${usage.unmeasuredRuns === 1 ? "was" : "were"} stored before machine time was measured; their minutes are not here.`
                : undefined,
    };
};

// ---- Where the time went: the run's wall time split by what it waited for, along the host that finished last.

export type TimeSegment = {
    key: "start" | "list" | "boot" | "setup" | "specs" | "results" | "rest";
    label: string;
    ms: number;
};
export type HostTimeLine = {
    label: string;
    specs: number;
    bootMs?: number;
    setupMs?: number;
    specsMs?: number;
};
export type SuiteTimeSplit = {
    totalMs: number;
    segments: TimeSegment[];
    hosts: HostTimeLine[];
    /** False when a run recorded only part of the moments: the last segment then covers what was not told apart. */
    complete: boolean;
};

const at = (iso?: string) => (iso ? Date.parse(iso) : undefined);
const span = (from?: number, to?: number) =>
    from !== undefined && to !== undefined && to > from ? to - from : undefined;

/** The suite's wall time by phase, or null for a run with no host moments (a run from before they were recorded, a static cell). */
export const suiteTimeSplit = (run: RuntimeSuiteRun): SuiteTimeSplit | null => {
    const start = at(run.requestedAt);
    const end = at(run.finishedAt);
    const shards = (run.hostTimes ?? []).filter((h) => h.role === "shard");
    if (start === undefined || end === undefined || shards.length === 0)
        return null;
    const list = run.hostTimes.find((h) => h.role === "list");
    const lastOf = (h: (typeof shards)[number]) =>
        at(h.finishedAt) ?? at(h.endedAt) ?? at(h.readyAt) ?? 0;
    const critical = shards.reduce((a, b) => (lastOf(b) > lastOf(a) ? b : a));
    const firstShardAsked = Math.min(
        ...shards.map((h) => at(h.requestedAt) ?? Infinity),
    );
    const marks: Array<[TimeSegment["key"], string, number | undefined]> = [
        [
            "start",
            run.mode === "run"
                ? "Before the suite started (the Run's own tests)"
                : "Before the suite started",
            at(list?.requestedAt) ??
                (Number.isFinite(firstShardAsked)
                    ? firstShardAsked
                    : undefined),
        ],
        [
            "list",
            "Listing the specs on main",
            list && Number.isFinite(firstShardAsked)
                ? firstShardAsked
                : undefined,
        ],
        ["boot", "Host boot", at(critical.readyAt)],
        ["setup", "App up on the host", at(critical.startedAt)],
        ["specs", "Running the specs", at(critical.finishedAt)],
    ];
    const segments: TimeSegment[] = [];
    let from = start;
    for (const [key, label, to] of marks) {
        if (to === undefined) continue;
        const clamped = Math.min(Math.max(to, from), end);
        if (clamped > from) segments.push({ key, label, ms: clamped - from });
        from = clamped;
    }
    const complete = !!critical.startedAt && !!critical.finishedAt;
    if (end > from)
        segments.push(
            complete
                ? {
                      key: "results",
                      label:
                          run.machine && run.machine.rerunMs > 0
                              ? "Re-runs of the failures, results and cleanup"
                              : "Results and cleanup",
                      ms: end - from,
                  }
                : {
                      key: "rest",
                      label: "App, specs and results",
                      ms: end - from,
                  },
        );
    const specsOf = new Map(run.shards.map((s) => [s.shard, s.specs]));
    return {
        totalMs: end - start,
        segments,
        complete,
        hosts: [...shards]
            .sort((a, b) => a.shard - b.shard)
            .map((h) => {
                const boot = span(at(h.requestedAt), at(h.readyAt));
                const setup = span(at(h.readyAt), at(h.startedAt));
                const specs = span(at(h.startedAt), at(h.finishedAt));
                return {
                    label: `Host ${h.shard + 1}`,
                    specs: specsOf.get(h.shard) ?? 0,
                    ...(boot !== undefined ? { bootMs: boot } : {}),
                    ...(setup !== undefined ? { setupMs: setup } : {}),
                    ...(specs !== undefined ? { specsMs: specs } : {}),
                };
            }),
    };
};

// ---- The specs table.

export type SpecBucket = "failed" | "flaky" | "passed" | "skipped";
export type SpecFilter = "all" | SpecBucket;

/** Which filter a spec falls under: a failure the classifier called flaky is flaky, not failed. */
export const specBucket = (r: RuntimeSuiteSpec): SpecBucket => {
    if (r.result === "flaky" || r.group === "flaky") return "flaky";
    if (r.result === "passed") return "passed";
    if (r.result === "skipped") return "skipped";
    return "failed";
};

export type SpecResultLabel = { label: string; tone: Tone };

export const specResultLabel = (r: RuntimeSuiteSpec): SpecResultLabel => {
    if (r.group === "regression")
        return { label: "Regression", tone: "danger" };
    if (r.group === "pre_existing")
        return { label: "Fails on main too", tone: "warning" };
    if (r.result === "flaky" || r.group === "flaky")
        return { label: "Flaky", tone: "warning" };
    if (r.result === "passed") return { label: "Passed", tone: "success" };
    if (r.result === "skipped") return { label: "Skipped", tone: "neutral" };
    if (r.result === "not_run" || r.result === "infra")
        return { label: "Not run", tone: "neutral" };
    return { label: "Failed", tone: "danger" };
};

const BUCKET_ORDER: SpecBucket[] = ["failed", "flaky", "skipped", "passed"];

/** The rows a filter and a search keep: failures first, then the slowest. */
export const specRows = (
    run: RuntimeSuiteRun,
    filter: SpecFilter,
    query: string,
): RuntimeSuiteSpec[] => {
    const q = query.trim().toLowerCase();
    return (run.specRows ?? [])
        .filter((r) => filter === "all" || specBucket(r) === filter)
        .filter(
            (r) =>
                !q ||
                r.spec.toLowerCase().includes(q) ||
                r.tests.some((t) => t.title.toLowerCase().includes(q)),
        )
        .sort(
            (a, b) =>
                BUCKET_ORDER.indexOf(specBucket(a)) -
                    BUCKET_ORDER.indexOf(specBucket(b)) ||
                b.durationMs - a.durationMs ||
                a.spec.localeCompare(b.spec),
        );
};

export const specCounts = (
    run: RuntimeSuiteRun,
): Record<SpecFilter, number> => {
    const counts: Record<SpecFilter, number> = {
        all: 0,
        failed: 0,
        flaky: 0,
        passed: 0,
        skipped: 0,
    };
    for (const r of run.specRows ?? []) {
        counts.all++;
        counts[specBucket(r)]++;
    }
    return counts;
};
