import { CalculateDoraMetricsUseCase } from './calculate-dora-metrics.use-case';
import { CalculateMetricsUseCase } from './calculate-metrics.use-case';
import { GetDoraMetricsByOrganizationUseCase } from './get-dora-metrics-by-organization.use-case';
import { GetDoraMetricsByTeamUseCase } from './get-dora-metrics-by-team.use-case';
import { GetTeamDoraMetricsForCockPitUseCase } from './get-dora-metrics-for-cockpit.use-case';
import { GetTeamMetricsByIdUseCase } from './get-metrics-by-id.use-case';
import { GetMetricsByOrganizationUseCase } from './get-metrics-by-organization.use-case';
import { GetMetricsByTeamUseCase } from './get-metrics-by-team.use-case';
import { SaveAllTeamMetricsHistoryUseCase } from './save-all-metrics-history.use-case';
import { SaveDoraMetricsToDbUseCase } from './save-db-dora-metrics.use-case';
import { SaveFlowMetricsToDbUseCase } from './save-db-flow-metrics.use-case';

export const UseCases = [
    CalculateMetricsUseCase,
    SaveFlowMetricsToDbUseCase,
    SaveAllTeamMetricsHistoryUseCase,
    GetMetricsByTeamUseCase,
    GetMetricsByOrganizationUseCase,
    GetTeamMetricsByIdUseCase,
    CalculateDoraMetricsUseCase,
    SaveDoraMetricsToDbUseCase,
    GetTeamDoraMetricsForCockPitUseCase,
    GetDoraMetricsByTeamUseCase,
    GetDoraMetricsByOrganizationUseCase,
];
