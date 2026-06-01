import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import { ParametersEntity } from '../entities/parameters.entity';
import { IParameters } from '../interfaces/parameters.interface';

export const PARAMETERS_REPOSITORY_TOKEN = Symbol.for('ParametersRepository');

export interface IParametersRepository {
    find<K extends ParametersKey>(
        filter?: Partial<IParameters<K>>,
    ): Promise<ParametersEntity<K>[]>;
    findOne<K extends ParametersKey>(
        filter?: Partial<IParameters<K>>,
    ): Promise<ParametersEntity<K>>;
    findById<K extends ParametersKey>(
        uuid: string,
    ): Promise<ParametersEntity<K> | undefined>;
    findByOrganizationName<K extends ParametersKey>(
        organizationName: string,
    ): Promise<ParametersEntity<K> | undefined>;
    create<K extends ParametersKey>(
        integrationConfig: IParameters<K>,
    ): Promise<ParametersEntity<K> | undefined>;
    update<K extends ParametersKey>(
        filter: Partial<IParameters<K>>,
        data: Partial<IParameters<K>>,
    ): Promise<ParametersEntity<K> | undefined>;
    delete(uuid: string): Promise<void>;
    deleteByTeamId(teamId: string): Promise<void>;
    findByKey<K extends ParametersKey>(
        configKey: K,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ParametersEntity<K>>;

    /**
     * Atomically deactivates every currently-active row for
     * (teamId, configKey) and inserts a brand-new active row with
     * `version = nextVersion`. The deactivate + insert run inside a single
     * transaction so a concurrent writer cannot observe the team without an
     * active config; the underlying partial unique index then guarantees
     * that two transactions racing the same flow cannot both commit.
     *
     * The bulk deactivate is intentional (not "deactivate the one row we
     * just read"): it sweeps any orphan active rows left behind by the
     * unfixed flow, making this method self-healing for teams that are
     * already in the corrupt state.
     */
    createNewActiveVersion<K extends ParametersKey>(
        configKey: K,
        teamId: string,
        configValue: IParameters<K>['configValue'],
        nextVersion: number,
    ): Promise<ParametersEntity<K> | undefined>;
}
