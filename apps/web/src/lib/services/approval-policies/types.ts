export type ApprovalPolicy = {
    id: string;
    name: string;
    enabled: boolean;
    labels?: string[];
    authors?: string[];
    authorTeams?: string[];
    includedFiles?: string[];
    excludedFiles?: string[];
    maxChangedLines?: number;
    lineCountExcludedFiles?: string[];
    instruction?: string;
};
