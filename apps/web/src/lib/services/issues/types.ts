import type { SeverityLevel } from "src/core/types";

export type IssueStatus = "open" | "dismissed" | "resolved";

export type IssueCategory =
    | "performance_and_optimization"
    | "security"
    | "error_handling"
    | "refactoring"
    | "maintainability"
    | "potential_issues"
    | "code_style"
    | "documentation_and_comments"
    | "kody_rules"
    | "breaking_changes"
    | "deterministic";

export type IssueListItem = {
    createdAt: string;
    filePath: string;
    label: IssueCategory;
    repository: { name: string; id: string };
    severity: SeverityLevel;
    status: IssueStatus;
    title: string;
    uuid: string;
    prNumbers: string[];
    kodyRule?: {
        number?: string;
        title?: string;
    } | null;
};

export type IssueItem = {
    title: string;
    description: string;
    age: string;
    label: IssueCategory;
    severity: SeverityLevel;
    status: IssueStatus;
    fileLink: { label: string; url: string };
    prLinks: [{ label: string; url: string }];
    repositoryLink: { label: string; url: string };
    reactions: { thumbsUp: number; thumbsDown: number };
    gitOrganizationName: string;
    language: string;
    repository: {
        id: string;
        name: string;
    };
    kodyRule?: {
        number?: string;
        title?: string;
    } | null;
};

export type IssueCreationConfigResponse = {
    uuid: string;
    configKey: string;
    configValue: boolean | { enabled: boolean };
};
