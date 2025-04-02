import { METRICS_TYPE } from '../../metrics/enums/metrics.enum';
import { METRICS_CATEGORY } from '../../metrics/enums/metricsCategory.enum';
import { IOrganization } from '../../organization/interfaces/organization.interface';

export interface IOrganizationMetrics {
    uuid?: string;
    type: METRICS_TYPE;
    value: any;
    status: boolean;
    organization?: Partial<IOrganization>;
    createdAt?: string;
    referenceDate?: string;
    category?: METRICS_CATEGORY;
}
