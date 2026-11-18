import type { ProbeVerdict, RuntimeRun, RunUncovered } from "../contracts";
import { blockerKindLabel, RUN_PATH_OUTCOME_META, type Tone } from "../labels";
import { baseVersionLabel } from "./base-version";
import { code, codeList, type RichText } from "./rich-text";
import type { RunPath, RunPaths } from "./run-paths";

// "What Kody tested": one row per path of the PR with a plain state, the
// reason when it was not tested and, for a blocker, what to add. Built from
// the paths (run-paths.ts) and, when the API serves it, the report's
// `uncovered` reasons.

export type CoverageMark =
    "same" | "regression" | "intended" | "new" | "untested";

export type CoverageRow = {
    key: string;
    entryPoint: string;
    /** What the row shows: the entry point, or what a probe outside this PR's paths sent. */
    route: string;
    outsideDiff: boolean;
    /** The changed file this route reaches, by Kody's mapping (not coverage of the file). */
    via?: string;
    mark: CoverageMark;
    label: string;
    tone: Tone;
    /** One line: "200 on main · 200 on this PR", or why it was not tested. */
    detail: RichText;
    /** Where the developer can remove the blocker. */
    action?: { href: string; label: string };
    /** The tested path, for its evidence; absent for an entry point no probe reached. */
    path?: RunPath;
};

const UNCOVERED_REASON: Record<RunUncovered["reason"], string> = {
    no_probe: "No check reached it.",
    pre_existing:
        "The same failure was observed on both versions. This path was exercised but could not be cleared.",
    not_reached: "No request reached it during the test.",
    inconclusive:
        "The base version answered differently between attempts, so no comparison holds.",
    unverified: "Kody could not verify the result.",
    blocker: "Something the app needs was missing.",
};

/** Why a probe that ran could not decide, by its verdict. */
const UNDECIDED_REASON: Partial<Record<ProbeVerdict["verdict"], string>> = {
    inconclusive: UNCOVERED_REASON.inconclusive,
    blocker: "Something the app needs was missing, so the check could not run.",
    unverified: UNCOVERED_REASON.unverified,
};

const reasonLabel = (reason: RunUncovered["reason"], baseLabel: string) =>
    reason === "inconclusive"
        ? `${baseLabel} answered differently between attempts, so no comparison holds.`
        : UNCOVERED_REASON[reason];

const environmentHref = (environmentId: string) =>
    `/runtime/environments/${encodeURIComponent(environmentId)}`;

/** Why an entry point could not be cleared, and what to do about it. */
export const untestedReason = (
    uncovered: RunUncovered | undefined,
    environmentId: string,
    baseLabel = baseVersionLabel(),
): Pick<CoverageRow, "detail" | "action"> => {
    if (!uncovered) return { detail: [UNCOVERED_REASON.no_probe] };
    const blocker = uncovered.blocker;
    if (uncovered.reason !== "blocker" || !blocker)
        return { detail: [reasonLabel(uncovered.reason, baseLabel)] };
    if (blocker.kind === "missing_env" && blocker.name)
        return {
            detail: [
                "Needs ",
                code(blocker.name),
                ", which this environment does not have.",
            ],
            action: {
                href: environmentHref(environmentId),
                label: `Add ${blocker.name}`,
            },
        };
    // A member's PR the environment's recipe does not boot: never matched against another service.
    if (blocker.kind === "other_repo" && blocker.alias)
        return {
            detail: [
                "The setup file does not boot ",
                code(blocker.alias),
                ". Add it to ",
                code("services.needs"),
                " in .kodus/workspace.yaml on the default branch.",
            ],
            action: {
                href: environmentHref(environmentId),
                label: "Open the environment",
            },
        };
    return {
        detail: [`Blocked: ${blockerKindLabel(blocker.kind).toLowerCase()}.`],
        action: {
            href: environmentHref(environmentId),
            label: "Open the environment",
        },
    };
};

const answersLine = (path: RunPath, baseLabel: string) =>
    path.answers
        ? `${path.answers.main} on ${baseLabel} · ${path.answers.pr} on this PR`
        : path.summary;

const MARK: Record<RunPath["outcome"], CoverageMark> = {
    regression: "regression",
    new_endpoint_error: "regression",
    new_endpoint: "new",
    intended: "intended",
    could_not_test: "untested",
    pre_existing: "same",
    same: "same",
};

export const coverageRows = (
    runPaths: Pick<RunPaths, "paths" | "untested">,
    run: Pick<
        RuntimeRun,
        "environmentId" | "uncovered" | "probes" | "findings" | "baseBranch"
    >,
): CoverageRow[] => {
    const recordedBaseLabel = baseVersionLabel(run);
    const uncoveredBy = new Map(
        (run.uncovered ?? []).map((u) => [u.entryPoint, u]),
    );
    const verdictOf = new Map(
        [...(run.findings ?? []), ...(run.probes ?? [])].map((p) => [
            `${p.probeId}::${p.entryPoint}`,
            p.verdict,
        ]),
    );
    const rows: CoverageRow[] = runPaths.paths.map((path) => {
        const baseLabel = path.baseLabel ?? recordedBaseLabel;
        const meta = RUN_PATH_OUTCOME_META[path.outcome];
        const base = {
            key: `${path.probeId}::${path.entryPoint}`,
            entryPoint: path.entryPoint,
            route: path.route,
            outsideDiff: path.outsideDiff,
            ...(path.via ? { via: path.via } : {}),
            mark: MARK[path.outcome],
            label: meta.label,
            tone: meta.tone,
            path,
        };
        const fields = path.differingFields.filter((f) => f !== "status");
        switch (path.outcome) {
            case "could_not_test": {
                const fromReport = uncoveredBy.get(path.entryPoint);
                if (fromReport)
                    return {
                        ...base,
                        ...untestedReason(
                            fromReport,
                            run.environmentId,
                            baseLabel,
                        ),
                    };
                const verdict = verdictOf.get(base.key);
                return {
                    ...base,
                    detail: [
                        (verdict === "inconclusive"
                            ? reasonLabel("inconclusive", baseLabel)
                            : verdict && UNDECIDED_REASON[verdict]) ??
                            UNCOVERED_REASON.unverified,
                    ],
                };
            }
            case "pre_existing":
                return {
                    ...base,
                    detail: [
                        `${answersLine(path, baseLabel)} · fails the same way on ${baseLabel}, so this PR did not cause it`,
                    ],
                };
            case "new_endpoint":
                return {
                    ...base,
                    detail: [
                        `${answersLine(path, baseLabel)} · a route this PR adds; ${baseLabel} has no such route, so this is new behavior, not a regression`,
                    ],
                };
            case "new_endpoint_error":
                return {
                    ...base,
                    detail: [
                        `${answersLine(path, baseLabel)} · the route this PR adds fails; ${baseLabel} has no such route to compare with`,
                    ],
                };
            case "intended":
                return {
                    ...base,
                    detail: fields.length
                        ? ["Differs in ", ...codeList(fields)]
                        : [answersLine(path, baseLabel)],
                };
            default:
                return {
                    ...base,
                    detail: [answersLine(path, baseLabel)],
                };
        }
    });
    for (const u of runPaths.untested) {
        const meta = RUN_PATH_OUTCOME_META.could_not_test;
        rows.push({
            key: `untested::${u.entryPoint}`,
            entryPoint: u.entryPoint,
            route: u.entryPoint,
            outsideDiff: false,
            mark: "untested",
            label: meta.label,
            tone: meta.tone,
            ...untestedReason(
                uncoveredBy.get(u.entryPoint),
                run.environmentId,
                recordedBaseLabel,
            ),
        });
    }
    return rows;
};
