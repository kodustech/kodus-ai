
import { ITeam } from '../../team/interfaces/team.interface';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';

export interface IParameters {
    uuid: string;
    configKey: ParametersKey;
    configValue: any;
    team?: Partial<ITeam>;
}
