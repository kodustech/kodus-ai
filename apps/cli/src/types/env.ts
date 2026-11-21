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
    evidence?: { lines: string[]; service?: string };
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

export type EnvTarget = { environmentId?: string; repositoryId?: string };
