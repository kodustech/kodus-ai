import type { ResponseDiff } from "../contracts";

// The answer's fields that differ between main and this PR, as the backend
// cut and redacted them (ProbeVerdict.responseDiff): one row per field, with
// whether this PR removed, added or changed it.

export type ResponseDiffChange = "removed" | "added" | "changed";

export type ResponseDiffRow = {
    path: string;
    /** Absent: main's answer has no such field. */
    base?: string;
    /** Absent: this PR's answer has no such field. */
    pr?: string;
    change: ResponseDiffChange;
};

export type ResponseDiffView = {
    rows: ResponseDiffRow[];
    /** The backend kept only the first fields. */
    truncated: boolean;
};

export const RESPONSE_DIFF_CHANGE_LABEL: Record<ResponseDiffChange, string> = {
    removed: "removed",
    added: "added",
    changed: "changed",
};

export const responseDiffChange = (
    base: string | undefined,
    pr: string | undefined,
): ResponseDiffChange =>
    base !== undefined && pr === undefined
        ? "removed"
        : base === undefined && pr !== undefined
          ? "added"
          : "changed";

/** Rows to draw, or nothing when the verdict carries no field (older Runs). */
export const buildResponseDiff = (
    diff: ResponseDiff | undefined,
): ResponseDiffView | undefined => {
    const fields = (diff?.fields ?? []).filter(
        (f) => typeof f?.path === "string" && f.path !== "",
    );
    if (fields.length === 0) return undefined;
    return {
        rows: fields.map((f) => ({
            path: f.path,
            ...(typeof f.base === "string" ? { base: f.base } : {}),
            ...(typeof f.pr === "string" ? { pr: f.pr } : {}),
            change: responseDiffChange(
                typeof f.base === "string" ? f.base : undefined,
                typeof f.pr === "string" ? f.pr : undefined,
            ),
        })),
        truncated: diff?.truncated === true,
    };
};
