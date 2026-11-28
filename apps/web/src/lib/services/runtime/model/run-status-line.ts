import type { RunPublication, RuntimeRun } from "../contracts";
import { formatDurationMs, shortSha } from "../format";
import { runStateLabel } from "../labels";
import { baseVersionLabel } from "./base-version";
import { publicationLine, type PublicationKind } from "./publication";

// The Run page's one status line and its one warning: short, from the record.

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "✕ 1 regression · 2 min · c76abde vs main", or the state in a word and its reason. */
export const runStatusLine = (
    run: Pick<
        RuntimeRun,
        "state" | "headSha" | "baseSha" | "baseBranch" | "reason"
    >,
    regressions: number,
    totalMs?: number,
): string => {
    const parts: string[] = [];
    if (run.state === "regression" || regressions > 0)
        parts.push(`✕ ${plural(Math.max(regressions, 1), "regression")}`);
    else if (run.state === "no_regressions") parts.push("✓ No regressions");
    else parts.push(runStateLabel(run.state));
    if (
        run.reason &&
        run.state !== "regression" &&
        run.state !== "no_regressions"
    )
        parts.push(run.reason);
    if (totalMs !== undefined) parts.push(formatDurationMs(totalMs));
    parts.push(`${shortSha(run.headSha)} vs ${baseVersionLabel(run)}`);
    return parts.join(" · ");
};

export type PublicationWarning = { title: string; fix?: string };

const KIND_LABEL: Record<PublicationKind, string> = {
    check: "Check",
    comment: "Comment",
};

/** Only what failed to post; nothing when everything reached the PR (or posts nothing by design). */
export const publicationWarnings = (
    publication: RunPublication | undefined,
): PublicationWarning[] => {
    if (!publication || !publication.postsToPullRequest) return [];
    const out: PublicationWarning[] = [];
    for (const kind of ["check", "comment"] as const) {
        const view = publication[kind];
        const line = publicationLine(kind, view);
        if (view.status === "failed")
            out.push({
                title: `${KIND_LABEL[kind]} not posted: Kodus gave up after several tries.`,
            });
        else if (
            view.status === "skipped" &&
            view.reason === "status_permission_missing"
        )
            out.push({
                title: `${KIND_LABEL[kind]} not posted: the GitHub token can't write commit statuses.`,
                fix: line.detail,
            });
    }
    return out;
};
