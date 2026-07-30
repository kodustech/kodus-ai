import type {
    PullRequestExecution,
    PullRequestFile,
    PullRequestSuggestion,
} from "@services/pull-requests";
import type { DiffFile, PrInfo, ReviewIssue } from "./types";

function statusOf(raw: string | undefined): DiffFile["status"] {
    switch ((raw ?? "").toLowerCase()) {
        case "added":
            return "added";
        case "removed":
        case "deleted":
            return "deleted";
        case "renamed":
            return "renamed";
        default:
            return "modified";
    }
}

/**
 * Build the `diff --git` header that Pierre's PatchDiff (and the
 * try DiffViewer's `patchByPath` splitter) expects. GitHub-style patches
 * carry only hunk bodies (`@@ ...`) with no headers, so we synthesize them.
 * Mirrors the logic in web's pierre-diff.tsx PierrePatchDiffComponent.
 */
function buildFullPatch(file: PullRequestFile): string {
    const filename = file.filename;
    // Use || (not ??): the API sometimes sends previous_filename as an empty
    // string for non-renames, which would produce a bogus `a/ b/...` header
    // that the path splitter can't match, blanking out the whole diff.
    const prev = file.previous_filename || filename;
    const patch = file.patch ?? "";
    const isNewFile = patch.startsWith("@@ -0,0");
    const isDeletedFile = /^@@ -\d+,\d+ \+0,0 @@/.test(patch);
    const fromPath = isNewFile ? "/dev/null" : `a/${prev}`;
    const toPath = isDeletedFile ? "/dev/null" : `b/${filename}`;
    return `diff --git a/${prev} b/${filename}\n--- ${fromPath}\n+++ ${toPath}\n${patch}`;
}

/**
 * Adapts web's PR-review data into the shape the ported try DiffViewer
 * consumes: a list of DiffFiles (header metadata), a single concatenated
 * `rawDiff` string keyed back to each file by its `diff --git` header, and
 * a flat list of ReviewIssues (one per suggestion, keyed by file path).
 */
export function adaptForTryDiffViewer({
    patchFiles,
    suggestions,
}: {
    patchFiles: PullRequestFile[];
    suggestions: PullRequestSuggestion[];
}): {
    files: DiffFile[];
    rawDiff: string;
    issues: ReviewIssue[];
} {
    // Only files that actually carry a patch can be rendered by Pierre and
    // matched by the splitter; drop the rest so we don't emit empty blocks.
    const withPatch = patchFiles.filter((f) => !!f.patch);

    const files: DiffFile[] = withPatch.map((f) => ({
        path: f.filename,
        oldPath:
            f.previous_filename && f.previous_filename !== f.filename
                ? f.previous_filename
                : null,
        status: statusOf(f.status),
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
    }));

    const rawDiff = withPatch.map(buildFullPatch).join("\n");

    const issues: ReviewIssue[] = suggestions
        .filter((s) => !!s.filePath)
        .map((s) => {
            // The card body prefers the full suggestion content; fall back
            // to the one-sentence summary so the card never renders empty.
            const message =
                s.suggestionContent?.trim() ||
                s.oneSentenceSummary?.trim() ||
                "";

            // Surface the before/after code in the "Suggested fix" block.
            // improvedCode is the actionable bit; existingCode gives context.
            let suggestion: string | undefined;
            if (s.improvedCode?.trim()) {
                suggestion = s.improvedCode.trim();
            } else if (s.existingCode?.trim()) {
                suggestion = s.existingCode.trim();
            }

            return {
                id: s.id,
                file: s.filePath as string,
                line: s.relevantLinesStart ?? 0,
                endLine: s.relevantLinesEnd,
                severity: s.severity ?? "info",
                category: s.label,
                message,
                suggestion,
            };
        });

    return { files, rawDiff, issues };
}

export function buildPrInfo({
    prNumber,
    prUrl,
    repositoryName,
}: {
    prNumber: number;
    prUrl?: string;
    repositoryName?: string;
}): PrInfo | undefined {
    if (!prUrl) return undefined;
    const full = repositoryName ?? "";
    const [owner, repo] = full.includes("/")
        ? full.split("/")
        : ["", full];
    return {
        owner,
        repo,
        prNumber,
        htmlUrl: prUrl,
    };
}

/**
 * Builds the full PrInfo the ported PrHeader renders — title, state badge,
 * author, branches, head SHA and the +/- stats. Branch/title/author come from
 * the execution row; the file/line stats are summed from the diff so they
 * stay in sync with what the diff viewer actually shows.
 */
export function buildHeaderPrInfo({
    execution,
    patchFiles,
    prNumber,
    repositoryName,
    commitsCount,
}: {
    execution?: PullRequestExecution;
    patchFiles: PullRequestFile[];
    prNumber: number;
    repositoryName?: string;
    commitsCount?: number;
}): PrInfo {
    const full = repositoryName ?? execution?.repositoryName ?? "";
    const [owner, repo] = full.includes("/") ? full.split("/") : ["", full];

    const additions = patchFiles.reduce((n, f) => n + (f.additions ?? 0), 0);
    const deletions = patchFiles.reduce((n, f) => n + (f.deletions ?? 0), 0);

    const username = execution?.author?.username || execution?.author?.name;

    return {
        owner,
        repo,
        prNumber,
        title: execution?.title ?? `Pull request #${prNumber}`,
        htmlUrl: execution?.url ?? "",
        // Execution status is open | closed | merged; the badge wants a plain
        // open/closed plus separate merged/draft flags.
        state: execution?.status === "closed" ? "closed" : "open",
        merged: execution?.merged || execution?.status === "merged",
        isDraft: execution?.isDraft,
        author: username ? { login: username } : null,
        baseRef: execution?.baseBranchRef,
        headRef: execution?.headBranchRef,
        headSha: execution?.reviewedCommitSha ?? undefined,
        changedFiles: patchFiles.length,
        additions,
        deletions,
        commitsCount,
    };
}
