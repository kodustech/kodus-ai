import { SessionEntity } from '../entities/session.entity';
import { ISession } from '../interfaces/session.interface';

export const SESSION_REPOSITORY_TOKEN = Symbol('SessionRepository');

export interface ISessionRepository {
    create(session: Omit<ISession, 'uuid'>): Promise<SessionEntity>;
    update(
        filter: Partial<ISession>,
        data: Partial<ISession>,
    ): Promise<SessionEntity | undefined>;
    delete(uuid: string): Promise<void>;
    findById(uuid: string): Promise<SessionEntity | null>;
    find(filter?: Partial<ISession>): Promise<SessionEntity[]>;
    getNativeCollection(): any;
    findOne(filter?: Partial<ISession>): Promise<SessionEntity | null>;
}
