import { Module, forwardRef } from '@nestjs/common';
import { IntegrationModule } from './integration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { TeamsModule } from './team.module';
import { MetricsModule } from './metrics.module';
import { PromptService } from '@/core/infrastructure/adapters/services/prompt.service';
import { CheckinController } from '@/core/infrastructure/http/controllers/checkin.controller';
import { UseCases } from '@/core/application/use-cases/checkin';
import { CheckinService } from '@/core/infrastructure/adapters/services/checkin/checkin.service';
import { CHECKIN_SERVICE_TOKEN } from '@/core/domain/checkins/contracts/checkin.service.contract';
import { FlowMetricsCheckinSection } from '@/core/infrastructure/adapters/services/checkin/sections/teamFlowMetrics.section';
import { DoraMetricsCheckinSection } from '@/core/infrastructure/adapters/services/checkin/sections/teamDoraMetrics.section';
import { TeamArtifactsSection } from '@/core/infrastructure/adapters/services/checkin/sections/teamArtifacts.section';
import { ReleaseNotesSection } from '@/core/infrastructure/adapters/services/checkin/sections/releaseNotes.section';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { TeamArtifactsModule } from './teamArtifacts.module';
import { LateWorkItemsSection } from '@/core/infrastructure/adapters/services/checkin/sections/lateWorkItems.section';
import { PullRequestsOpenedSection } from '@/core/infrastructure/adapters/services/checkin/sections/pullRequestsOpen.section';
import { ParametersModule } from './parameters.module';
import { ButtonsSection } from '@/core/infrastructure/adapters/services/checkin/sections/buttons.section';
import { SnoozedItemsModule } from './snoozedItems.module';
import { CheckinHistoryModule } from './checkinHistory.module';
import { LogModule } from './log.module';

@Module({
    imports: [
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => TeamsModule),
        forwardRef(() => MetricsModule),
        forwardRef(() => PlatformIntegrationModule),
        forwardRef(() => TeamArtifactsModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => SnoozedItemsModule),
        forwardRef(() => CheckinHistoryModule),
        LogModule,
    ],
    providers: [
        ...UseCases,
        FlowMetricsCheckinSection,
        DoraMetricsCheckinSection,
        TeamArtifactsSection,
        ReleaseNotesSection,
        LateWorkItemsSection,
        PullRequestsOpenedSection,
        ButtonsSection,
        PromptService,
        {
            provide: CHECKIN_SERVICE_TOKEN,
            useClass: CheckinService,
        },
    ],
    controllers: [CheckinController],
    exports: [CHECKIN_SERVICE_TOKEN],
})
export class CheckinModule {}
