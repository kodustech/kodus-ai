import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@/shared/infrastructure/repositories/mappers';
import { ISessionRepository } from '@/core/domain/automation/contracts/session.repository.contracts';
import { SessionModel } from './schema/session.model';
import { SessionEntity } from '@/core/domain/automation/entities/session.entity';
import { ISession } from '@/core/domain/automation/interfaces/session.interface';

@Injectable()
export class SessionDatabaseRepository implements ISessionRepository {
    constructor(
        @InjectModel(SessionModel.name)
        private readonly sessionModel: Model<SessionModel>,
    ) {}

    async findOne(filter?: Partial<ISession>): Promise<SessionEntity> {
        try {
            const session = await this.sessionModel.findOne(filter).exec();

            return mapSimpleModelToEntity(session, SessionEntity);
        } catch (error) {
            console.log(error);
        }
    }

    getNativeCollection() {
        try {
            const nativeConnection = this.sessionModel.db.collection('session');

            return nativeConnection;
        } catch (error) {
            console.log(error);
        }
    }

    async create(session: ISession): Promise<SessionEntity> {
        try {
            const sessionSaved = await this.sessionModel.create(session);

            return mapSimpleModelToEntity(sessionSaved, SessionEntity);
        } catch (error) {
            console.log(error);
        }
    }

    async update(
        filter: Partial<ISession>,
        data: Partial<ISession>,
    ): Promise<SessionEntity> {
        try {
            const session = await this.sessionModel
                .findOne(filter)
                .lean()
                .exec();

            await this.sessionModel
                .updateOne(filter, {
                    ...session,
                    ...data,
                })
                .exec();

            return this.findById(session._id.toString());
        } catch (error) {
            console.log(error);
        }
    }

    async delete(uuid: string): Promise<void> {
        try {
            await this.sessionModel.deleteOne({ _id: uuid }).exec();
        } catch (error) {
            console.log(error);
        }
    }

    async findById(uuid: string): Promise<SessionEntity> {
        try {
            const session = await this.sessionModel.findOne({ _id: uuid });

            if (!session) {
                throw new Error('Session not found');
            }

            return mapSimpleModelToEntity(session, SessionEntity);
        } catch (error) {
            console.error('Error finding session by ID:', error);
            throw error;
        }
    }

    async find(filter?: Partial<ISession>): Promise<SessionEntity[]> {
        try {
            const sessions = await this.sessionModel
                .find(
                    {
                        ...filter,
                    },
                    null,
                )
                .exec();

            return mapSimpleModelsToEntities(sessions, SessionEntity);
        } catch (error) {
            console.log(error);
        }
    }
}
