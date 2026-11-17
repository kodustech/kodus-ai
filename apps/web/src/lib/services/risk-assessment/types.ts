export type RiskCriterion = {
    id: string;
    name: string;
    enabled: boolean;
    instructions: string;
    includedFiles?: string[];
    excludedFiles?: string[];
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
