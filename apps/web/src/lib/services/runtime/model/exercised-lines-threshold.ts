// The org's exercised-lines threshold (PATCH /runtime/settings
// { exercisedLinesThresholdPercent }, docs/runtime/exercised-lines.md §7):
// below this share of a Run's measured changed lines, a Run with no
// regression is partly tested. Null: the deployment's default applies.

const INVALID = "Enter a whole number from 0 to 100.";

/** The field's text as the value to send: null for empty (the default), or why it cannot be sent. */
export const exercisedThresholdDraft = (
    draft: string,
): { percent: number | null; error?: string } => {
    const text = draft.trim();
    if (text === "") return { percent: null };
    const n = Number(text);
    if (!Number.isInteger(n) || n < 0 || n > 100)
        return { percent: null, error: INVALID };
    return { percent: n };
};

/** Which threshold holds the org's Runs, in one sentence. */
export const exercisedThresholdWords = (
    value: number | null,
    defaultPercent: number,
): string => {
    const percent = value ?? defaultPercent;
    const whose =
        value === null ? "The default" : "Your organization's threshold";
    if (percent === 0)
        return `${whose} is 0%: how many changed lines ran never changes the verdict.`;
    return `${whose} applies: a Run needs ${percent}% of the changed lines to run.`;
};
