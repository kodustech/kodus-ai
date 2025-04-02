import { IAgentExecutionRepository } from '@/core/domain/agents/contracts/agent-execution.repository.contracts';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { AgentExecutionModel } from './schema/agent-execution.model';
import { Model } from 'mongoose';
import { IAgentExecution } from '@/core/domain/agents/interfaces/agent-execution.interface';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@/shared/infrastructure/repositories/mappers';
import { AgentExecutionEntity } from '@/core/domain/agents/entities/agent.execution.entity';

@Injectable()
export class AgentExecutionDatabaseRepository
    implements IAgentExecutionRepository
{
    constructor(
        @InjectModel(AgentExecutionModel.name)
        private readonly agentExecutionModel: Model<AgentExecutionModel>,
    ) {}

    async findOne(
        filter?: Partial<IAgentExecution>,
    ): Promise<AgentExecutionEntity> {
        try {
            const agentExecution = await this.agentExecutionModel
                .findOne(filter)
                .exec();

            return mapSimpleModelToEntity(agentExecution, AgentExecutionEntity);
        } catch (error) {
            console.log(error);
        }
    }

    getNativeCollection() {
        try {
            const nativeConnection =
                this.agentExecutionModel.db.collection('agentExecution');

            return nativeConnection;
        } catch (error) {
            console.log(error);
        }
    }

    async create(
        agentExecution: IAgentExecution,
    ): Promise<AgentExecutionEntity> {
        try {
            const agentExecutionSaved =
                await this.agentExecutionModel.create(agentExecution);

            return mapSimpleModelToEntity(
                agentExecutionSaved,
                AgentExecutionEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async update(
        filter: Partial<IAgentExecution>,
        data: Partial<IAgentExecution>,
    ): Promise<AgentExecutionEntity> {
        try {
            const agentExecution = await this.agentExecutionModel
                .findOne(filter)
                .lean()
                .exec();

            await this.agentExecutionModel
                .updateOne(filter, {
                    ...agentExecution,
                    ...data,
                })
                .exec();

            return this.findById(agentExecution._id.toString());
        } catch (error) {
            console.log(error);
        }
    }

    async delete(uuid: string): Promise<void> {
        try {
            await this.agentExecutionModel.deleteOne({ _id: uuid }).exec();
        } catch (error) {
            console.log(error);
        }
    }

    async findById(uuid: string): Promise<AgentExecutionEntity> {
        try {
            const agentExecution = await this.agentExecutionModel.findOne({ _id: uuid });

            if (!agentExecution) {
                throw new Error('AgentExecution not found');
            }

            return mapSimpleModelToEntity(agentExecution, AgentExecutionEntity);
        } catch (error) {
            console.log(error);
        }
    }

    async find(
        filter?: Partial<IAgentExecution>,
    ): Promise<AgentExecutionEntity[]> {
        try {
            const agentExecutions = await this.agentExecutionModel
                .find(
                    {
                        ...filter,
                    },
                    null,
                    { skip: 1 },
                )
                .exec();

            return mapSimpleModelsToEntities(
                agentExecutions,
                AgentExecutionEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }
}
