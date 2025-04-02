import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { InteractionModelInstance } from '@/core/infrastructure/adapters/repositories/mongoose/schema';
import { InteractionController } from '@/core/infrastructure/http/controllers/interaction.controller';
import { UseCases } from '@/core/application/use-cases/interaction';
import { InteractionService } from '@/core/infrastructure/adapters/services/interaction.service';
import { INTERACTION_SERVICE_TOKEN } from '@/core/domain/interactions/contracts/interaction.service.contracts';
import { INTERACTION_EXECUTION_REPOSITORY_TOKEN } from '@/core/domain/interactions/contracts/interaction.repository.contracts';
import { InteractionExecutionDatabaseRepository } from '@/core/infrastructure/adapters/repositories/mongoose/interactionExecution.repository';
import { TeamsModule } from '@/modules/team.module';

@Module({
    imports: [
        MongooseModule.forFeature([InteractionModelInstance]),
        TeamsModule,
    ],
    providers: [
        ...UseCases,
        {
            provide: INTERACTION_SERVICE_TOKEN,
            useClass: InteractionService,
        },
        {
            provide: INTERACTION_EXECUTION_REPOSITORY_TOKEN,
            useClass: InteractionExecutionDatabaseRepository,
        },
    ],
    controllers: [InteractionController],
})
export class InteractionModule {}
