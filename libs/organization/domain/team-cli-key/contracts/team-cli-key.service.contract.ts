import { ITeam } from '@libs/organization/domain/team/interfaces/team.interface';
import { IOrganization } from '@libs/organization/domain/organization/interfaces/organization.interface';
import { ITeamCliKeyRepository } from './team-cli-key.repository.contract';
import { ITeamCliKeyConfig } from '../interfaces/team-cli-key.interface';

export const TEAM_CLI_KEY_SERVICE_TOKEN = Symbol.for('TeamCliKeyService');

export interface ValidateKeyResult {
    /**
     * Identifier of the CLI key row that authenticated the request. Used by
     * the CLI review pipeline to record which key was used (so the dashboard
     * can show "Team: <name>" without ever logging the key itself).
     */
    keyId: string;
    keyName: string;
    team: Partial<ITeam>;
    organization: Partial<IOrganization>;
    config?: ITeamCliKeyConfig;
}

export interface ITeamCliKeyService extends ITeamCliKeyRepository {
    generateKey(
        teamId: string,
        name: string,
        createdByUserId: string,
        config?: ITeamCliKeyConfig,
    ): Promise<string>;
    validateKey(key: string): Promise<ValidateKeyResult | null>;
    revokeKey(keyId: string): Promise<void>;
}
