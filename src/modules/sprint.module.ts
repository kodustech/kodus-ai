import { SPRINT_REPOSITORY_TOKEN } from '@/core/domain/sprint/contracts/sprint.repository.contracts';
import { SPRINT_SERVICE_TOKEN } from '@/core/domain/sprint/contracts/sprint.service.contract';
import { SprintRepository } from '@/core/infrastructure/adapters/repositories/typeorm/sprint.repository';
import { SprintModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/sprint.model';
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SprintService } from '@/core/infrastructure/adapters/services/sprint.service';
import { MetricsModule } from './metrics.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { SprintController } from '@/core/infrastructure/http/controllers/sprint.controller';
import { UseCases } from '@/core/application/use-cases/sprint';
import { TeamArtifactsModule } from './teamArtifacts.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([SprintModel]),
        forwardRef(() => MetricsModule),
        forwardRef(() => PlatformIntegrationModule),
        TeamArtifactsModule
    ],
    providers: [
        ...UseCases,
        {
            provide: SPRINT_SERVICE_TOKEN,
            useClass: SprintService,
        },
        {
            provide: SPRINT_REPOSITORY_TOKEN,
            useClass: SprintRepository,
        },
    ],
    controllers: [SprintController],
    exports: [SPRINT_SERVICE_TOKEN, SPRINT_REPOSITORY_TOKEN],
})
export class SprintModule {}
