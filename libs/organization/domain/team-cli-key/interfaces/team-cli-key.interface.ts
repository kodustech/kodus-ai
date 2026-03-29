import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { ITeam } from '@libs/organization/domain/team/interfaces/team.interface';

export const TEAM_CLI_KEY_CAPABILITIES = {
    CONFIG_REPO_MANAGE: 'config:repo:manage',
    KODY_RULES_MANAGE: 'kodyRules:manage',
} as const;

export type TeamCliKeyCapability =
    (typeof TEAM_CLI_KEY_CAPABILITIES)[keyof typeof TEAM_CLI_KEY_CAPABILITIES];

export interface ITeamCliKeyConfig {
    capabilities?: TeamCliKeyCapability[];
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
