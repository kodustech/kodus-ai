import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { OrganizationParametersEntity } from '../entities/organizationParameters.entity';
import { IOrganizationParameters } from '../interfaces/organizationParameters.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

export const ORGANIZATION_PARAMETERS_REPOSITORY_TOKEN = Symbol(
    'OrganizationParametersRepository',
);

export type ConfigValueMerge = {
    /** Merges into `connections[connectionId]` instead of the top level. */
    connectionId?: string;
    /** Leaves an existing `connections[connectionId]` untouched. */
    onlyIfAbsent?: boolean;
};

export interface IOrganizationParametersRepository {
    /**
     * Merges `patch` into the stored value in one statement, so writers of
     * different keys (or of different connections) never drop each other's.
     */
    mergeConfigValue(
        configKey: OrganizationParametersKey,
        organizationId: string,
        patch: Record<string, unknown>,
        options?: ConfigValueMerge,
    ): Promise<void>;
    /**
     * Adds the bots found on a connection to the PR author lists (the
     * connection's own, or the organization's when none is named) in one
     * statement: only bots never seeded before are ignored, and the allow
     * list is never written.
     */
    seedBotIds(
        organizationId: string,
        botIds: string[],
        options?: { connectionId?: string },
    ): Promise<void>;
    find(
        filter?: Partial<IOrganizationParameters>,
    ): Promise<OrganizationParametersEntity[]>;
    findOne(
        filter?: Partial<IOrganizationParameters>,
    ): Promise<OrganizationParametersEntity>;
    findById(uuid: string): Promise<OrganizationParametersEntity | undefined>;
    findByOrganizationName(
        organizationName: string,
    ): Promise<OrganizationParametersEntity | undefined>;
    create(
        integrationConfig: IOrganizationParameters,
    ): Promise<OrganizationParametersEntity | undefined>;
    update(
        filter: Partial<IOrganizationParameters>,
        data: Partial<IOrganizationParameters>,
    ): Promise<OrganizationParametersEntity | undefined>;
    delete(uuid: string): Promise<void>;
    findByKey(
        configKey: OrganizationParametersKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<OrganizationParametersEntity>;
    findByKeyAndValue(filter: {
        configKey: OrganizationParametersKey;
        configValue: any;
        organizationAndTeamData?: OrganizationAndTeamData;
        fuzzy?: boolean;
    }): Promise<OrganizationParametersEntity[]>;
}
