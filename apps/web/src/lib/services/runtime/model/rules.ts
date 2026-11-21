import type {
    RuntimeMode,
    RuntimeRepositorySettings,
    RuntimeRuleCondition,
    RuntimeTriggerRule,
} from "../contracts";

// The "When it runs" draft of a repository (screen 2), kept apart from the
// component so the save rules are tested: what the API takes, and what the
// screen says.

export type RuleField = RuntimeRuleCondition["field"];

export const RULE_FIELDS: Array<{
    field: RuleField;
    label: string;
    placeholder: string;
}> = [
    {
        field: "changed_paths",
        label: "Changed paths match",
        placeholder: "db/migrations/**",
    },
    { field: "label", label: "Label includes", placeholder: "payments" },
    {
        field: "files_changed",
        label: "Files changed more than",
        placeholder: "30",
    },
];

/** A condition as the form holds it: the value is text until saved. */
export type DraftCondition = { field: RuleField; value: string };
export type DraftRule = { conditions: DraftCondition[] };

export type RuntimeDraft = Required<
    Pick<
        RuntimeRepositorySettings,
        "mode" | "whoCanAsk" | "runOnAgentPullRequests" | "runOnNewPushes"
    >
> & { rules: DraftRule[] };

export const toDraftCondition = (c: RuntimeRuleCondition): DraftCondition => ({
    field: c.field,
    value:
        c.field === "changed_paths"
            ? c.matches
            : c.field === "label"
              ? c.includes
              : String(c.moreThan),
});

/** The mode a saved row means: rows written before `mode` existed only had `pilot`. */
export const modeOf = (
    s: Pick<RuntimeRepositorySettings, "mode" | "pilot"> | undefined,
): RuntimeMode => s?.mode ?? (s?.pilot ? "on_request" : "off");

export const draftOf = (
    s: RuntimeRepositorySettings | undefined,
): RuntimeDraft => ({
    mode: modeOf(s),
    whoCanAsk: s?.whoCanAsk ?? "writers",
    runOnAgentPullRequests: s?.runOnAgentPullRequests ?? false,
    runOnNewPushes: s?.runOnNewPushes ?? false,
    rules: (s?.rules ?? []).map((r) => ({
        conditions: r.conditions.map(toDraftCondition),
    })),
});

export const conditionError = (c: DraftCondition): string | undefined => {
    const v = c.value.trim();
    if (!v) return "Required";
    if (c.field === "files_changed") {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) return "A whole number";
    }
    if (c.field === "changed_paths" && v.length > 256) return "Too long";
    if (c.field === "label" && v.length > 100) return "Too long";
    return undefined;
};

export const toCondition = (c: DraftCondition): RuntimeRuleCondition => {
    const v = c.value.trim();
    if (c.field === "files_changed")
        return { field: c.field, moreThan: Number(v) };
    if (c.field === "label") return { field: c.field, includes: v };
    return { field: c.field, matches: v };
};

export type RuntimeSettingsPayload = Omit<RuntimeDraft, "rules"> & {
    rules?: RuntimeTriggerRule[];
};

/**
 * What PUT /runtime/settings/repositories/:id takes, or the reason it cannot
 * be saved. Rules are checked and sent only in Rules mode: in another mode
 * the editor is hidden, so a half-written rule must not block the save, and
 * leaving `rules` out keeps the saved ones for when Rules is picked again.
 */
export const toPayload = (
    draft: RuntimeDraft,
):
    | { ok: true; body: RuntimeSettingsPayload }
    | { ok: false; error: string } => {
    const { rules, ...rest } = draft;
    if (draft.mode !== "rules") return { ok: true, body: rest };
    if (rules.length === 0)
        return {
            ok: false,
            error: "Add at least one rule, or pick another option.",
        };
    if (rules.some((r) => r.conditions.length === 0))
        return { ok: false, error: "Every rule needs a condition." };
    if (rules.some((r) => r.conditions.some((c) => conditionError(c))))
        return { ok: false, error: "Fill in every condition." };
    return {
        ok: true,
        body: {
            ...rest,
            rules: rules.map((r) => ({
                conditions: r.conditions.map(toCondition),
            })),
        },
    };
};

export const sameDraft = (a: RuntimeDraft, b: RuntimeDraft) =>
    JSON.stringify(a) === JSON.stringify(b);
