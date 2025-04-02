import { IInteractionExecutionRepository } from '@/core/domain/interactions/contracts/interaction.repository.contracts';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InteractionModel } from '@/core/infrastructure/adapters/repositories/mongoose/schema/interaction.model';
import { Model } from 'mongoose';
import { IInteractionExecution } from '@/core/domain/interactions/interfaces/interactions-execution.interface';

@Injectable()
export class InteractionExecutionDatabaseRepository
    implements IInteractionExecutionRepository
{
    constructor(
        @InjectModel(InteractionModel.name)
        private readonly interactionExecutionModel: Model<InteractionModel>,
    ) {}

    async create(
        interactionExecution: IInteractionExecution,
    ): Promise<InteractionModel> {
        return this.interactionExecutionModel.create(interactionExecution);
    }
}
