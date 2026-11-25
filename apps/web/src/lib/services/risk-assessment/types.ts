import { pathToApiUrl } from "src/core/utils/helpers";

export const RISK_ASSESSMENT_API_PATHS = {
    DEFAULT_CRITERIA: pathToApiUrl("/code-review/risk/default-criteria"),
};

/**
 * A stored rule: a team rule, or a Kodus default (same id) that the team
 * turned off or edited, holding only what it changes.
 */
export type RiskCriterion = {
    id: string;
    name?: string;
    enabled: boolean;
    instructions?: string;
    includedFiles?: string[];
    excludedFiles?: string[];
};

export type DefaultRiskCriterion = RiskCriterion & {
    name: string;
    instructions: string;
};

/** The settings preview only renders these public fields of the assessment. */
export type RiskAssessmentView =
    | { status: "disabled" }
    | { status: "unavailable"; reason: string }
    | { status: "assessed"; riskIdentified: boolean; reason: string };

export type RiskPreview = {
    assessment: RiskAssessmentView;
    files: Array<{ path: string; previousPath?: string; status?: string }>;
};
