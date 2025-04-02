import { CalculateOrganizationDoraMetricsUseCase } from './calculate-dora-metrics.use-case';
import { CalculateOrganizationMetricsUseCase } from './calculate-metrics.use-case';
import { GetOrganizationDoraMetricsByIdUseCase } from './get-dora-metrics-by-id.use-case';
import { GetOrganizationMetricsByIdUseCase } from './get-metrics-by-id.use-case';
import { SaveOrganizationMetricsToDbUseCase } from './save-metrics.use-case';
import { SaveAllOrganizationMetricsHistoryUseCase } from './save-metrics-history.use-case';

export const UseCases = [
    CalculateOrganizationMetricsUseCase,
    SaveOrganizationMetricsToDbUseCase,
    GetOrganizationMetricsByIdUseCase,
    CalculateOrganizationDoraMetricsUseCase,
    GetOrganizationDoraMetricsByIdUseCase,
    SaveAllOrganizationMetricsHistoryUseCase,
];
