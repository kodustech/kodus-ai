export type LiteralUnion<LiteralType extends string> =
    | LiteralType
    | (string & Record<never, never>);

export type AwaitedReturnType<T extends (...args: any) => any> = Awaited<
    ReturnType<T>
>;

export type IntegrationsCommon = {
    name: string;
    id: string;
    key?: string;
    projectType?: string;
    isPrivate?: boolean;
    isConfirmed?: boolean;
    selected: boolean;
    url?: string;
};

export interface Cookies {
    [key: string]: string | undefined;
}

export enum SeverityLevel {
    CRITICAL = "critical",
    HIGH = "high",
    MEDIUM = "medium",
    LOW = "low",
}

export enum TEAM_STATUS {
    ACTIVE = "active",
    INACTIVE = "inactive",
    PENDING = "pending",
    REMOVED = "removed",
}

export enum IntegrationCategory {
    CODE_MANAGEMENT = "CODE_MANAGEMENT",
    PROJECT_MANAGEMENT = "PROJECT_MANAGEMENT",
    COMMUNICATION = "COMMUNICATION",
}

export enum AuthMode {
    OAUTH = "oauth",
    TOKEN = "token",
    BASIC = "basic",
}

export type OrganizationAndTeamData = {
    organizationId?: string;
    teamId?: string;
};

export type TODO = any;

export enum PlatformType {
    GITHUB = "GITHUB",
    GITLAB = "GITLAB",
    AZURE_REPOS = "AZURE_REPOS",
    BITBUCKET = "BITBUCKET",
    FORGEJO = "FORGEJO",
}
