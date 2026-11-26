/** Stored risk rules per scope, counting overrides of Kodus's rules. */
export const MAX_RISK_CRITERIA = 50;

/** Ids starting with this are reserved for the risk rules Kodus ships. */
export const DEFAULT_RISK_CRITERION_PREFIX = 'kodus-';

/** The risk rules Kodus ships; a stored `kodus-` id overrides one of them. */
export const KODUS_RISK_RULE_IDS = [
    'kodus-security',
    'kodus-money',
    'kodus-data',
    'kodus-infrastructure',
    'kodus-ci-build',
    'kodus-shared-contract',
    'kodus-concurrency',
    'kodus-ai-behavior',
    'kodus-broad-change',
] as const;

export type KodusRiskRuleId = (typeof KODUS_RISK_RULE_IDS)[number];

/**
 * Rules Kodus no longer ships. Moving an id here keeps the configs that still
 * name it valid; the override is dropped when the rules are resolved.
 */
export const RETIRED_KODUS_RISK_RULE_IDS: readonly string[] = [];

/** A `kodus-` id Kodus ships or once shipped; anything else is a typo. */
export const isKnownKodusRiskRuleId = (id: string) =>
    (KODUS_RISK_RULE_IDS as readonly string[]).includes(id) ||
    RETIRED_KODUS_RISK_RULE_IDS.includes(id);
