import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { SessionEntity } from '../entities/session.entity';
import { ISession } from '../interfaces/session.interface';
import { ISessionRepository } from './session.repository.contracts';

export const SESSION_SERVICE_TOKEN = Symbol('SessionService');

export interface ISessionService extends ISessionRepository {
    register(session: Omit<ISession, 'uuid'>): Promise<SessionEntity>;
    checkIfHasActiveSessions(
        platformUserId: string,
        organizationAndTeamData?: OrganizationAndTeamData,
    ): Promise<SessionEntity>;
}
