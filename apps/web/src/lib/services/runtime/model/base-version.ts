import type { RuntimeRun } from "../contracts";

/** Never infer a branch name from side=base or from the repository default. */
export const baseVersionLabel = (
    run: Pick<RuntimeRun, "baseBranch"> = {},
): string => run.baseBranch?.trim() || "base version";

/** A side's display name; wire side identifiers remain unchanged. */
export const comparisonSideLabel = (
    side: "base" | "pr",
    baseLabel = baseVersionLabel(),
): string => (side === "base" ? baseLabel : "this PR");
