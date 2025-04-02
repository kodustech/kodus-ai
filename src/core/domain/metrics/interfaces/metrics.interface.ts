import { ITeam } from '../../team/interfaces/team.interface';
import { METRICS_TYPE } from '../enums/metrics.enum';
import { METRICS_CATEGORY } from '../enums/metricsCategory.enum';

export interface IMetrics {
    uuid: string;
    type: METRICS_TYPE;
    value: any;
    status: boolean;
    team?: Partial<ITeam>;
    createdAt?: string;
    category?: METRICS_CATEGORY;
    referenceDate?: string;
}
