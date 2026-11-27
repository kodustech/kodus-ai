/** What /mcp/env answers for env_blockers and env_fix (libs/mcp-server/tools/env.tools.ts). */
export type EnvFixView = {
    id: string;
    action: string;
    who: string;
    label: string;
    detail?: string;
    host?: string;
    recipeDiff?: string;
    learned?: { scope: 'repo' | 'org'; helped: number; lastAt: string };
};

export type EnvBlockerGroup = {
    signature: string;
    kind: string;
    title: string;
    count: number;
    lastAt?: string;
    lastPr?: number;
    evidence?: { lines: string[]; service?: string; step?: string };
    fixes: EnvFixView[];
};

export type EnvStatus = {
    environment: {
        environmentId: string;
        repositoryId: string;
        repositoryName: string;
        state: string;
    };
    blockers: EnvBlockerGroup[];
};

export type EnvFixResult =
    | { action: 'retry_setup'; setupRequested: true }
    | {
          action: 'set_env' | 'raise_health_timeout';
          pullRequest: { number: number; url: string };
      };

export type EnvTarget = {
    environmentId?: string;
    repositoryId?: string;
    /** owner/name, from the working directory's git remote: a recipe reaches a repository with no environment yet. */
    repository?: string;
};

/** A build file a recipe carries, directly under .kodus/ (env_recipe_check / env_recipe_submit). */
export type EnvRecipeFile = { path: string; content: string };

export type EnvRecipeInput = EnvTarget & {
    recipe: string;
    files?: EnvRecipeFile[];
};

/** env_recipe_check: whether Kodus would boot the recipe, and what it read from it. */
export type EnvRecipeCheck = {
    ok: boolean;
    errors: string[];
    warnings?: string[];
    /** The default-branch head the repository checks read. */
    readAt?: string;
    /** No environmentId: the repository has none yet, and `kodus env recipe submit` makes it. */
    environment: { environmentId?: string; repositoryName: string };
    summary?: {
        public?: string;
        health?: string;
        expose: Array<{ service: string; port: number; kind: string }>;
    };
};

/** env_recipe_guide: the authoring rules as text. */
export type EnvRecipeGuide = { guide: string };

/** env_recipe_submit: the setup that boots it (env_status answers it as setupKey once it is the latest). */
export type EnvRecipeSubmit = {
    setupRequested: true;
    environmentId: string;
    recipeDigest: string;
    setupKey: string;
};

/** env_status: the environment's health and which setup it reads. */
export type EnvHealth = {
    environmentId: string;
    state: 'setting_up' | 'active' | 'blocked' | 'not_set_up';
    setupKey?: string;
    boots7d: number;
    bootRate7d?: number;
    readyP50Ms?: number;
    imageId?: string;
    cellId?: string;
    blockers: Array<{
        signature: string;
        kind: string;
        count: number;
        lastAt: string;
    }>;
};
