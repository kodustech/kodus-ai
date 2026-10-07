/** Mirrors `BusinessLogicStatus` in libs/agents/business-validation/runs/insights.ts. */
export type BusinessLogicStatus = {
    state: "working" | "paused" | "idle";
    lastTaskRead?: { id: string; tracker: string; at: string };
    paused?: { tracker: string; since: string; uncheckedPullRequests: number };
    stats: {
        pullRequestsChecked: number;
        metRate?: number;
        agreedRate?: number;
        couldntRead: number;
        couldntReadByReason: Record<string, number>;
    };
    pointsElsewhere?: { pullRequests: number; kind: string };
};

export type TaskSourceOption = {
    integrationId: string;
    name: string;
    kind: "managed" | "custom";
};

export type ReadTool = {
    name: string;
    description?: string;
    recommended: boolean;
};

export type BusinessLogicSettingsValue = {
    taskSource?: string;
    taskSourceTool?: string;
    criteriaLocation?: "auto" | "heading" | "field";
    criteriaHeading?: string;
    criteriaField?: string;
    failOn?: Array<"missing" | "partial" | "not_in_task">;
    teamGuidance?: string;
    commentWhenMet?: boolean;
    recheckOnPush?: boolean;
};

export type TryReadResult = {
    status:
        | "found"
        | "no_reference"
        | "no_tracker"
        | "not_found"
        | "unavailable"
        | "cant_read";
    task?: {
        id: string;
        title?: string;
        tracker: string;
        url?: string;
        descriptionLength: number;
        acceptanceCriteria: number;
        criteriaFromSettings: boolean;
        canJudge: boolean;
        hasAttachments: boolean;
    };
    message?: string;
};

export type RequirementTopic =
    | "empty_and_error_states"
    | "permissions"
    | "default_values"
    | "validation"
    | "audit_and_logging"
    | "data_and_persistence"
    | "notifications"
    | "ui_and_copy"
    | "integrations"
    | "performance"
    | "other";

/** Mirrors `IntentCockpit` in libs/agents/business-validation/runs/insights.ts. */
export type IntentCockpit = {
    pullRequests: number;
    metRate?: number;
    previousMetRate?: number;
    notInTaskRate?: number;
    agreedRate?: number;
    withoutTaskRate?: number;
    byAuthor: Array<{ author: string; pullRequests: number; metRate: number }>;
    unidentifiedRate?: number;
    mostMissed: Array<{ topic: RequirementTopic; pullRequests: number }>;
    byTeam: Array<{
        teamId: string;
        pullRequests: number;
        metRate?: number;
        notInTaskRate?: number;
        withoutTaskRate?: number;
    }>;
};
