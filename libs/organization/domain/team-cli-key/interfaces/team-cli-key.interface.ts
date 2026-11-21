import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { ITeam } from '@libs/organization/domain/team/interfaces/team.interface';

export const TEAM_CLI_KEY_CAPABILITIES = {
    CONFIG_REPO_MANAGE: 'config:repo:manage',
    KODY_RULES_MANAGE: 'kodyRules:manage',
    /** Read Kody Runtime Runs (and their stream) of the repos in `repositoryIds` (ADR-057). */
    RUNS_READ: 'runs:read',
    /** Open a Kody Runtime environment and run commands in it, over /mcp/env, for the repos in `repositoryIds` (ADR-057). */
    ENV_EXEC: 'env:exec',
    /** Apply a catalog fix to a blocked environment of the repos in `repositoryIds` (ADR-057). */
    ENV_FIX: 'env:fix',
    /** Submit external Runtime findings for the key's repositories (ADR-023/049). */
    FINDINGS_SUBMIT: 'findings:submit',
} as const;

export type TeamCliKeyCapability =
    (typeof TEAM_CLI_KEY_CAPABILITIES)[keyof typeof TEAM_CLI_KEY_CAPABILITIES];

export interface ITeamCliKeyConfig {
    capabilities?: TeamCliKeyCapability[];
    /**
     * Repositories the key reaches (ADR-057). Runtime capabilities (`runs:read`,
     * `env:exec`, `env:fix`) only apply to these; an empty or missing list reaches none of them.
     */
    repositoryIds?: string[];
}

export interface ITeamCliKey {
    uuid: string;
    name: string;
    keyHash: string;
    keyPrefix?: string;
    active: boolean;
    config?: ITeamCliKeyConfig;
    lastUsedAt?: Date;
    createdAt?: Date;
    updatedAt?: Date;
    team?: Partial<ITeam>;
    createdBy?: Partial<IUser>;
}
