import type {
    DefaultRiskCriterion,
    RiskCriterion,
} from "@services/risk-assessment/types";

/** A rule as the page lists it: a Kodus default with the team's changes, or a team rule. */
export type RiskRuleRow = DefaultRiskCriterion & {
    isDefault: boolean;
    /** A default whose name, instructions or files the team changed. */
    edited: boolean;
};

const EDITABLE = [
    "name",
    "instructions",
    "includedFiles",
    "excludedFiles",
] as const;

const stored = (rule: RiskCriterion): RiskCriterion =>
    Object.fromEntries(
        Object.entries({
            id: rule.id,
            name: rule.name,
            enabled: rule.enabled,
            instructions: rule.instructions,
            includedFiles: rule.includedFiles,
            excludedFiles: rule.excludedFiles,
        }).filter(([, value]) => value !== undefined),
    ) as RiskCriterion;

export function riskRuleRows(
    defaults: readonly DefaultRiskCriterion[],
    criteria: readonly RiskCriterion[],
): RiskRuleRow[] {
    const byId = new Map(criteria.map((rule) => [rule.id, rule]));
    const defaultIds = new Set(defaults.map((rule) => rule.id));
    return [
        ...defaults.map((base) => {
            const override = byId.get(base.id);
            return {
                ...base,
                ...(override ? stored(override) : {}),
                isDefault: true,
                edited:
                    !!override &&
                    EDITABLE.some((key) => override[key] !== undefined),
            } as RiskRuleRow;
        }),
        // An override of a default Kodus no longer ships has no name to show.
        ...criteria
            .filter(
                (rule) =>
                    !defaultIds.has(rule.id) && rule.name && rule.instructions,
            )
            .map(
                (rule) =>
                    ({
                        ...rule,
                        isDefault: false,
                        edited: false,
                    }) as RiskRuleRow,
            ),
    ];
}

/**
 * The stored list with `rule` applied. A default keeps only what differs from
 * Kodus's version, so Kodus's later wording still reaches what the team did
 * not change; a default left as Kodus ships it is not stored at all.
 */
export function applyRiskRule(
    defaults: readonly DefaultRiskCriterion[],
    criteria: readonly RiskCriterion[],
    rule: RiskCriterion,
): RiskCriterion[] {
    const base = defaults.find((item) => item.id === rule.id);
    const entry = base ? overrideOf(base, rule) : stored(rule);
    if (!entry) return criteria.filter((item) => item.id !== rule.id);
    return criteria.some((item) => item.id === rule.id)
        ? criteria.map((item) => (item.id === rule.id ? entry : item))
        : [...criteria, entry];
}

/** A default back to Kodus's name, instructions and files, on or off as it was. */
export const resetRiskRule = (
    defaults: readonly DefaultRiskCriterion[],
    criteria: readonly RiskCriterion[],
    id: string,
) =>
    applyRiskRule(defaults, criteria, {
        id,
        enabled: criteria.find((item) => item.id === id)?.enabled ?? true,
    });

function overrideOf(
    base: DefaultRiskCriterion,
    rule: RiskCriterion,
): RiskCriterion | undefined {
    const entry: RiskCriterion = { id: base.id, enabled: rule.enabled };
    if (rule.name && rule.name !== base.name) entry.name = rule.name;
    if (rule.instructions && rule.instructions !== base.instructions)
        entry.instructions = rule.instructions;
    if (rule.includedFiles?.length) entry.includedFiles = rule.includedFiles;
    if (rule.excludedFiles?.length) entry.excludedFiles = rule.excludedFiles;
    const changesSomething =
        !entry.enabled || EDITABLE.some((key) => entry[key] !== undefined);
    return changesSomething ? entry : undefined;
}
