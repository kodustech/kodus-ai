export const CLI_KEY_CAPABILITIES = {
    CONFIG_REPO_MANAGE: "config:repo:manage",
    KODY_RULES_MANAGE: "kodyRules:manage",
} as const;

export type CLIKeyCapability =
    (typeof CLI_KEY_CAPABILITIES)[keyof typeof CLI_KEY_CAPABILITIES];

export type CLIKeyConfig = {
    capabilities?: CLIKeyCapability[];
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
