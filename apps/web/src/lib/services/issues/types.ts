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
    | "deterministic"
    | "repo_instruction";

/** Where an issue was born. The API omits it for code review issues. */
export type IssueSource = "code_review" | "security_scan";

export type IssueOwner = {
    gitId: string;
    username: string;
    email?: string;
    origin?: "pr_author" | "codeowners" | "last_author";
};

export type SecurityVulnerabilityClass =
    "authz" | "injection" | "ssrf" | "data_exposure" | "secret_identity";

export type IssueSecurityDetails = {
    cwe?: string;
    vulnerabilityClass?: SecurityVulnerabilityClass;
    symbol?: string;
    startLine?: number;
    endLine?: number;
    lastSeenAt?: string;
    evidence?: {
        attackPath: { file: string; line: number; note: string }[];
        reproduction?: {
            path: string;
            content: string;
            command: string;
            executed: boolean;
            exitCode?: number;
            reproduced?: boolean;
            output?: string;
        };
    };
};

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
    source?: IssueSource;
    cwe?: string;
    owner?: IssueOwner;
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
    source?: IssueSource;
    owner?: IssueOwner;
    security?: IssueSecurityDetails;
};

export type IssueCreationConfigResponse = {
    uuid: string;
    configKey: string;
    configValue: boolean | { enabled: boolean };
};
