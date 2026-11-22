import type {
    DiffRef,
    FindingIntentMark,
    FindingIntentResult,
    ProbeRequest,
    ProbeVerdict,
    ResponseDiff,
    RuntimeRun,
} from "../contracts";
import type { RunStepView } from "../stream";
import { baseVersionLabel } from "./base-version";
import type { ReplayLanes } from "./replay-lanes";
import { resultOf, shownRouteOf } from "./run-paths";

// The Findings section: what behaves differently on this PR, with the proof.
// One card per finding (regressions first, then what the PR intends), with
// what each side answered per round. The evidence block switches on its kind
// so the browser (screenshots, video, trace) and back-end (replay lanes, DB
// diff) evidence slot in when the cell produces them; today a probe yields
// an HTTP answer or a command's exit code.

/** `browser` and `replay` are in the evidence contract but no cell produces them yet. */
export type EvidenceKind = "http" | "exec" | "unknown";

export type FindingRound = {
    stepId: string;
    round: number;
    /** "201", "exit 1", "no answer", "running". */
    answer: string;
    status?: number;
    exitCode?: number;
    durationMs?: number;
    lost: boolean;
};

export type FindingSide = {
    side: "base" | "pr";
    sha: string;
    rounds: FindingRound[];
    /** The first round's answer; "not recorded" when the stream kept no step. */
    answer: string;
    /** Every finished round answered the same. */
    steady: boolean;
};

export type Finding = {
    /** Comparison reference as recorded by the Run; absent on legacy hand-built views. */
    baseLabel?: string;
    probeId: string;
    entryPoint: string;
    /** What the screens name: the entry point, or what a probe outside this PR's paths sent. */
    route: string;
    /** The changed file with no route of its own that `entryPoint` reaches: Kody's mapping, never measured coverage. */
    via?: string;
    intended: boolean;
    /** "status 201 → 500 · body.error differs". */
    change: string;
    differingFields: string[];
    base: FindingSide;
    pr: FindingSide;
    /** "Same request, 2 attempts on main and 2 on this PR". */
    proof: string;
    evidenceKind: EvidenceKind;
    /** The Run kept a script that reproduces it. */
    reproducible: boolean;
    /** This PR does not boot while main does: the verdict's `boot` finding, with no request behind it. */
    boot: boolean;
    /** The machine itself failed on this PR (pr_destabilizes_machine). */
    destabilizes: boolean;
    /** A route this PR adds answers 5xx where main has no such route (new_endpoint_error): a finding on the new code. */
    newEndpoint?: true;
    /** "POST web:3000/orders", when the Run kept the probe's request. */
    request?: string;
    /** What the probe expected, written before it ran. */
    expected?: string;
    /** What the probe set out to check, as Kody wrote it (the PR list's title of a regression). */
    purpose?: string;
    /** Kody's review comment this finding reproduces, on the Kodus PR page. */
    reviewHref?: string;
    /** A developer marked it "this change is intended" (a learning signal; the check keeps what Kody measured). */
    markedIntended?: { mine: boolean; at: string };
    /** Main and this PR on one clock, with the first difference (absent on older Runs). */
    lanes?: ReplayLanes;
    /** The answer's fields that differ, with both values (absent on older Runs). */
    responseDiff?: ResponseDiff;
    /** A finding on an object or array field, leaf by leaf: what differs inside it and which leaves the PR's description reads. */
    leafChanges?: NonNullable<ProbeVerdict["leafChanges"]>;
    /** Where the diff changes the code this probe reaches. */
    diffRef?: DiffRef;
    /** What shows an intended finding is intended: the PR's diff spells it out, or a test that existed on main expects it. */
    intendedBy?: "diff" | "test";
    /** The values the diff swaps: main's and this PR's literal, and the added line (only with `intendedBy: "diff"`). */
    intendedChange?: NonNullable<ProbeVerdict["intendedChange"]>;
    /**
     * A regression whose PR answer is the status the probe expected before it
     * ran, where main answered that it has no such route: new behavior that
     * may well be what the PR means to do (expectationMatched).
     */
    matchesExpectation?: true;
};

/** Main's answer for a route it does not have. */
const NO_SUCH_ROUTE = new Set([404, 405]);

/**
 * Whether a regression is new behavior the PR announced: the expectation is a
 * bare status (the one shape the gate itself can check, probe-assertions.ts
 * httpExpectedHolds), every round of this PR answered it, and every round of
 * main answered that the route does not exist. A prose expectation says
 * nothing either way.
 */
export const expectationMatched = (
    f: Pick<Finding, "intended" | "boot" | "newEndpoint" | "expected"> & {
        base: Pick<FindingSide, "rounds">;
        pr: Pick<FindingSide, "rounds">;
    },
): boolean => {
    if (f.intended || f.boot || f.newEndpoint) return false;
    const expected = f.expected?.trim() ?? "";
    if (!/^\d{3}$/.test(expected)) return false;
    const statuses = (rounds: Pick<FindingRound, "status">[]) =>
        rounds.map((r) => r.status);
    const pr = statuses(f.pr.rounds);
    const base = statuses(f.base.rounds);
    return (
        pr.length > 0 &&
        base.length > 0 &&
        pr.every((s) => s === Number(expected)) &&
        base.every((s) => s !== undefined && NO_SUCH_ROUTE.has(s))
    );
};

/** Regressions first, then the ones the PR announced, then what it intends. */
const findingRank = (f: Pick<Finding, "intended" | "matchesExpectation">) =>
    f.intended ? 2 : f.matchesExpectation ? 1 : 0;

/** The finding the Run records when this PR does not boot while main does (run-orchestrator `verdict:boot`). */
export const isBootFinding = (
    p: Pick<ProbeVerdict, "entryPoint" | "findingKind">,
): boolean =>
    p.entryPoint === "boot" && p.findingKind === "pr_destabilizes_machine";

const SUGGESTION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The Kodus PR page opened on a review suggestion (its deep link), or nothing when the Run lacks what it needs. */
export const reviewSuggestionHref = (
    repositoryId: string | undefined,
    prNumber: number | undefined,
    suggestionId: string | undefined,
): string | undefined =>
    repositoryId && prNumber && suggestionId && SUGGESTION_ID.test(suggestionId)
        ? `/pull-requests/${encodeURIComponent(repositoryId)}/${prNumber}?suggestion=${encodeURIComponent(suggestionId)}`
        : undefined;

/** The request a probe sent, in one line: method and target for http, the page for a browser probe. */
export const requestLine = (r: ProbeRequest): string => {
    const target = r.service ? `${r.service}${r.port ? `:${r.port}` : ""}` : "";
    if (r.kind === "http")
        return [r.method, `${target}${r.path ?? ""}`].filter(Boolean).join(" ");
    if (r.kind === "browser") return `browser ${target}${r.path ?? ""}`.trim();
    return `SQL query${target ? ` on ${target}` : ""}`;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const sideOf = (
    side: "base" | "pr",
    sha: string,
    ids: string[] | undefined,
    byId: Map<string, RunStepView>,
): FindingSide => {
    const rounds = (ids ?? []).map((stepId, i): FindingRound => {
        const step = byId.get(stepId);
        return {
            stepId,
            round: i + 1,
            answer: resultOf(step),
            status: step?.status,
            exitCode: step?.exitCode,
            durationMs: step?.durationMs,
            lost: step?.transport === "lost",
        };
    });
    const finished = rounds.filter(
        (r) => r.answer !== "running" && r.answer !== "not recorded",
    );
    return {
        side,
        sha,
        rounds,
        answer: rounds[0]?.answer ?? "not recorded",
        steady:
            finished.length > 0 &&
            finished.every((r) => r.answer === finished[0].answer),
    };
};

export const evidenceKindOf = (sides: readonly FindingSide[]): EvidenceKind => {
    const rounds = sides.flatMap((s) => s.rounds);
    if (rounds.some((r) => r.status !== undefined)) return "http";
    if (rounds.some((r) => r.exitCode !== undefined)) return "exec";
    return "unknown";
};

/** "status 201 → 500 · body.error differs", from the answers and the gate's fields. */
export const changeLine = (
    base: FindingSide,
    pr: FindingSide,
    differingFields: readonly string[],
    baseLabel = baseVersionLabel(),
): string => {
    const parts: string[] = [];
    const known = (a: string) => a !== "not recorded" && a !== "running";
    if (known(base.answer) && known(pr.answer) && base.answer !== pr.answer)
        parts.push(
            base.rounds[0]?.status !== undefined ||
                pr.rounds[0]?.status !== undefined
                ? `status ${base.answer} → ${pr.answer}`
                : `${base.answer} → ${pr.answer}`,
        );
    const fields = differingFields.filter(
        (f) => f !== "status" || parts.length === 0,
    );
    if (fields.length)
        parts.push(
            `${fields.join(", ")} ${fields.length === 1 ? "differs" : "differ"}`,
        );
    return parts.join(" · ") || `differs from ${baseLabel}`;
};

const requestOf = (r: ProbeRequest | undefined) =>
    r
        ? {
              request: requestLine(r),
              expected: r.expected,
              ...(r.purpose?.trim() ? { purpose: r.purpose } : {}),
          }
        : {};

export const buildFindings = (
    run: Pick<
        RuntimeRun,
        | "findings"
        | "probes"
        | "headSha"
        | "baseSha"
        | "baseBranch"
        | "reproducible"
        | "probeRequests"
    > &
        Partial<Pick<RuntimeRun, "repositoryId" | "prNumber" | "intendedBy">>,
    steps: readonly RunStepView[],
): Finding[] => {
    const baseLabel = baseVersionLabel(run);
    const byId = new Map(steps.map((s) => [s.stepId, s]));
    const seen = new Map<string, ProbeVerdict>();
    for (const p of [...(run.findings ?? []), ...(run.probes ?? [])])
        if (p.verdict === "finding")
            seen.set(`${p.probeId}::${p.entryPoint}`, p);
    const reproducible = new Set(run.reproducible ?? []);
    return [...seen.values()]
        .map((p): Finding => {
            const base = sideOf("base", run.baseSha, p.baseStepIds, byId);
            const pr = sideOf("pr", run.headSha, p.prStepIds, byId);
            const differingFields = p.differingFields ?? [];
            const rounds =
                base.rounds.length || pr.rounds.length
                    ? `Same request, ${plural(base.rounds.length, "attempt")} on ${baseLabel} and ${pr.rounds.length} on this PR`
                    : `Same request on ${baseLabel} and on this PR`;
            const finding: Finding = {
                baseLabel,
                probeId: p.probeId,
                entryPoint: p.entryPoint,
                route: shownRouteOf(p).route,
                ...optional("via", p.via || undefined),
                intended: p.intent === "intended",
                change: isBootFinding(p)
                    ? `${baseLabel} booted · this PR did not boot`
                    : changeLine(base, pr, differingFields, baseLabel),
                boot: isBootFinding(p),
                differingFields,
                base,
                pr,
                proof:
                    base.steady && pr.steady && base.rounds.length > 1
                        ? `${rounds}, the same answer every attempt`
                        : rounds,
                evidenceKind: evidenceKindOf([base, pr]),
                reproducible: reproducible.has(p.probeId),
                destabilizes: p.findingKind === "pr_destabilizes_machine",
                ...(p.findingKind === "new_endpoint_error"
                    ? { newEndpoint: true as const }
                    : {}),
                ...requestOf(run.probeRequests?.[p.probeId]),
                ...optional(
                    "reviewHref",
                    reviewSuggestionHref(
                        run.repositoryId,
                        run.prNumber,
                        p.suggestionId,
                    ),
                ),
                ...optional(
                    "markedIntended",
                    markOf(run.intendedBy?.[p.probeId]),
                ),
                ...optional("lanes", p.lanes),
                ...optional("responseDiff", p.responseDiff),
                ...optional(
                    "leafChanges",
                    p.leafChanges?.undescribed.length
                        ? p.leafChanges
                        : undefined,
                ),
                ...optional("diffRef", p.diffRef),
                ...(p.intent === "intended"
                    ? {
                          intendedBy: p.intendedChange?.length
                              ? ("diff" as const)
                              : ("test" as const),
                      }
                    : {}),
                ...optional(
                    "intendedChange",
                    p.intent === "intended" && p.intendedChange?.length
                        ? p.intendedChange
                        : undefined,
                ),
            };
            return expectationMatched(finding)
                ? { ...finding, matchesExpectation: true }
                : finding;
        })
        .sort((a, b) => findingRank(a) - findingRank(b));
};

const optional = <K extends string, V>(key: K, value: V | undefined) =>
    (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

const markOf = (m: FindingIntentMark | undefined) =>
    m ? { mine: m.mine, at: m.at } : undefined;

/** The Run as the cache keeps it after PUT …/intent answered: the mark set, or cleared. */
export const withIntentResult = <R extends Pick<RuntimeRun, "intendedBy">>(
    run: R,
    probeId: string,
    result: FindingIntentResult,
): R => {
    const { [probeId]: _previous, ...rest } = run.intendedBy ?? {};
    if (!result.intended) return { ...run, intendedBy: rest };
    const { intended: _flag, ...mark } = result;
    return { ...run, intendedBy: { ...rest, [probeId]: mark } };
};
