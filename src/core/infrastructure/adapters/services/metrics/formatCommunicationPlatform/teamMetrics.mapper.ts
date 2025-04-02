import { DoraMetricsResults } from '@/shared/domain/interfaces/metrics';
import { FlowMetricsResults } from '@/shared/domain/interfaces/metrics';
import { DeployFrequencyMapper } from '../metricsMapping/doraMetrics/deployFrequency';
import { LeadTimeForChangeMapper } from '../metricsMapping/doraMetrics/leadTimeForChange';
import { BugRatioMapper } from '../metricsMapping/flowMetrics/bugRatio';
import { LeadTimeByColumnMapper } from '../metricsMapping/flowMetrics/leadTimeByColumn';
import { LeadTimeInWipMapper } from '../metricsMapping/flowMetrics/leadTimeInWip';
import { ThroughputMapper } from '../metricsMapping/flowMetrics/throughput';

export class TeamMetricsMapper {
    async mapTeamMetrics(
        flowMetrics: FlowMetricsResults,
        doraMetrics: DoraMetricsResults,
    ) {
        const mappedMetrics: any = {};

        const bugRatioMapper = new BugRatioMapper();
        const throughputMapper = new ThroughputMapper();
        const leadTimeInWipMapper = new LeadTimeInWipMapper();
        const leadTimeByColumnMapper = new LeadTimeByColumnMapper();
        const leadTimeForChangeMapper = new LeadTimeForChangeMapper();
        const deployFrequencyMapper = new DeployFrequencyMapper();

        if (flowMetrics) {
            if (flowMetrics?.bugRatio) {
                mappedMetrics.bugRatio = bugRatioMapper.map(
                    flowMetrics.bugRatio,
                );
            }

            if (flowMetrics?.throughput) {
                mappedMetrics.throughput = throughputMapper.map(
                    flowMetrics.throughput,
                );
            }

            if (flowMetrics?.leadTime) {
                mappedMetrics.leadTime = leadTimeInWipMapper.map(
                    flowMetrics.leadTime,
                );
            }

            if (flowMetrics?.leadTimeInWip) {
                mappedMetrics.leadTimeInWip = leadTimeInWipMapper.map(
                    flowMetrics.leadTimeInWip,
                );
            }

            if (flowMetrics?.leadTimeByColumn) {
                mappedMetrics.leadTimeByColumn = leadTimeByColumnMapper.map(
                    flowMetrics.leadTimeByColumn,
                );
            }
        }

        if (doraMetrics) {
            if (doraMetrics?.leadTimeForChange) {
                mappedMetrics.leadTimeForChange = leadTimeForChangeMapper.map(
                    doraMetrics.leadTimeForChange,
                );
            }

            if (doraMetrics?.deployFrequency) {
                mappedMetrics.deployFrequency = deployFrequencyMapper.map(
                    doraMetrics.deployFrequency,
                );
            }
        }

        return mappedMetrics;
    }
}
