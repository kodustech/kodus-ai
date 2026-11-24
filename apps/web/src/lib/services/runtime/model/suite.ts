import type {
    RuntimeEnvironmentSuite,
    RuntimeSuiteFailure,
    RuntimeSuiteFailureGroup,
    RuntimeSuiteRun,
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

type FullReason = NonNullable<RuntimeSuiteRun["selection"]["reason"]>;

/** Why the whole suite ran, as a clause: "The whole suite ran: …" and "Why all N specs". */
const FULL_REASON_TEXT: Record<FullReason, string> = {
    manifest: "a dependency manifest changed",
    lockfile: "a lockfile changed",
    config: "a runner, build or compose configuration changed",
    shared_routing: "shared routing or setup code changed",
    uncovered_file: "a changed file is covered by no spec, so nothing is skipped on a guess",
    map_missing: "no coverage map is stored for this environment yet",
    changes_unknown: "the files this pull request changes could not be read",
    map_stale: "the stored coverage map is too old to trust",
    map_digest: "the suite changed since the coverage map was made",
    noise_file: "a changed file is exercised by most specs",
    ready_for_review: "the pull request is ready for review",
    baseline: "this is the baseline on main",
    shadow: "this is a shadow run that checks the selection",
    selection_miss: "the shadow check found a failure the selection had skipped, so the whole suite runs for a while",
    selection_off: "spec selection is off for this environment",
};

const reasonText = (reason: FullReason | undefined) =>
    reason ? FULL_REASON_TEXT[reason] : undefined;

const times = (n: number) =>
    n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;

/** "1 test was already failing on main and 1 is flaky; neither blocks." Empty when there is neither. */
const noiseSentence = (preExisting: number, flaky: number): string => {
    const parts = [
        preExisting > 0 ? `${plural(preExisting, "test")} ${preExisting === 1 ? "was" : "were"} already failing on main` : undefined,
        flaky > 0 ? `${preExisting > 0 ? flaky : plural(flaky, "test")} ${flaky === 1 ? "is" : "are"} flaky` : undefined,
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
            sentence: "A newer push or a closed pull request stopped this suite.",
        };
    if (run.state === "errored")
        return {
            tone: "danger",
            title: "Could not finish",
            sentence: "The suite stopped before it could report. Run the failed specs again.",
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

export type SuiteFact = { label: string; value: string; hint: string; mono?: boolean };

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
        { label: "Specs run", value: `${run.specs.ran} of ${run.specs.total}`, hint: why },
        {
            label: "Duration",
            value: formatDurationMs(run.durationMs),
            hint: run.hosts === 1 ? "1 host" : `${run.hosts} hosts, one shard each`,
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
            : {
                  label: "Machine time",
                  value: "Not recorded",
                  hint: "This run was stored before machine time was measured",
              },
    ];
};

const GROUPS: Array<{ group: RuntimeSuiteFailureGroup; label: string; tone: Tone }> = [
    { group: "regression", label: "Regression", tone: "danger" },
    { group: "unclassified", label: "Unclassified", tone: "alert" },
    { group: "pre_existing", label: "Already failing on main", tone: "warning" },
    { group: "flaky", label: "Flaky", tone: "info" },
];

/** The failed tests by whose fault they are; a group with none is left out. */
export const failureGroups = (run: RuntimeSuiteRun) =>
    GROUPS.map((g) => ({ ...g, items: run.failures.filter((f) => f.group === g.group) })).filter((g) => g.items.length > 0);

export const attemptsLine = (pr: RuntimeSuiteFailure["pr"]) =>
    pr.attempts === 0 ? "no attempt recorded" : `failed ${pr.failed} of ${pr.attempts}`;

export const mainLine = (f: RuntimeSuiteFailure): string => {
    if (!f.main) return "not run for this test";
    if (f.main.outcome === "passed") return "passed";
    if (f.main.outcome === "not_run") return "not run";
    return f.main.sameError ? "failed, the same error" : "failed, with another error";
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
    "The whole suite runs instead when a lockfile, manifest or config changes, when the map is missing or stale, or after the shadow check found a miss.";

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
    const rows = Object.entries(s.reachedBy ?? {}).map(([file, specs]) => ({ file, specs: specs.map(baseName).join(", ") }));
    if (rows.length === 0)
        return {
            title,
            summary: s.mode === "none" ? "no spec is reached by this change" : "which changed file reached which spec was not recorded for this run",
            rows,
            note: WHY_NOTE,
        };
    return { title, summary: `coverage map · ${plural(rows.length, "changed file")}`, rows, note: WHY_NOTE };
};

const GATE_TEXT = {
    default: "Neutral: only a confirmed regression fails the check",
    strict: "Strict: anything unconfirmed fails the check too",
} as const;

const RUNNER_NAME: Record<string, string> = { playwright: "Playwright", cypress: "Cypress" };

/** "From the recipe": what `.kodus/workspace.yaml` says, read only (the file is where it is edited). */
export const environmentSuiteFacts = (suite: RuntimeEnvironmentSuite): Array<{ label: string; value: string; mono?: boolean }> => {
    const r = suite.recipe;
    if (!r) return [];
    const base = suite.lastBaseline;
    return [
        { label: "Runner", value: RUNNER_NAME[r.runner] ?? r.runner },
        { label: "Specs", value: base ? `${r.specs} · ${plural(base.specs, "file")}` : r.specs, mono: true },
        { label: "Command", value: r.command, mono: true },
        ...(r.results ? [{ label: "Results", value: r.results, mono: true }] : []),
        {
            label: "Last baseline on main",
            value: base ? `${shortSha(base.sha)} · ${base.passed} passed, ${base.failed} failed` : "No baseline on main yet",
        },
        { label: "Maximum hosts per run", value: r.shards !== undefined ? String(r.shards) : "Up to the recipe's default" },
        { label: "When a failure cannot be classified", value: GATE_TEXT[r.gate] },
    ];
};

/** The "selection paused" banner: shown only while the shadow check's brake holds; a person's own switch is just the switch. */
export const selectionBanner = (selection: RuntimeEnvironmentSuite["selection"]): { title: string; body: string } | undefined => {
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

const KIND_TEXT: Record<RuntimeSuiteUsage["lines"][number]["kind"], { label: string; what: string }> = {
    pr: { label: "PR", what: "First pass on each pull request" },
    baseline: { label: "Baseline", what: "Whole suite on main, with coverage" },
    rerun: { label: "Re-run", what: "Failed specs again, on the PR and on main" },
    shadow: { label: "Shadow", what: "Whole suite in the background to check selection" },
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
        totalMinutes: measured.length ? measured.reduce((n, l) => n + (l.minutes ?? 0), 0) : undefined,
        saved: usage.saved
            ? `In the ${usage.saved.shadowedRuns} selected runs a full shadow run also covered, selection saved ${grouped(usage.saved.minutes)} minutes.`
            : undefined,
        caveat:
            usage.unmeasuredRuns > 0
                ? `${plural(usage.unmeasuredRuns, "run")} ${usage.unmeasuredRuns === 1 ? "was" : "were"} stored before machine time was measured; their minutes are not here.`
                : undefined,
    };
};
