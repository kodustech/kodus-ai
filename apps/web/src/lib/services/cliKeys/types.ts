export const CLI_KEY_CAPABILITIES = {
    CONFIG_REPO_MANAGE: "config:repo:manage",
    KODY_RULES_MANAGE: "kodyRules:manage",
    /** Read Kody Runtime Runs of the key's repositories (`repositoryIds`). */
    RUNS_READ: "runs:read",
    /** Open a Kody Runtime environment and run commands in it (/mcp/env). */
    ENV_EXEC: "env:exec",
    /** Apply a catalog fix to a blocked Kody Runtime environment. */
    ENV_FIX: "env:fix",
    /** Submit external findings and follow their scoped verification tasks. */
    FINDINGS_SUBMIT: "findings:submit",
} as const;

export type CLIKeyCapability =
    (typeof CLI_KEY_CAPABILITIES)[keyof typeof CLI_KEY_CAPABILITIES];

export type CLIKeyConfig = {
    capabilities?: CLIKeyCapability[];
    /** The repositories the Runtime capabilities reach; none when empty. */
    repositoryIds?: string[];
};

export type CLIKey = {
    uuid: string;
    name: string;
    active: boolean;
    config?: CLIKeyConfig | null;
    lastUsedAt?: string | null;
    createdAt: string;
    createdBy: {
        uuid: string;
        name: string;
        email: string;
    };
};

export type CreateCLIKeyResponse = {
    key: string;
    message?: string;
};
