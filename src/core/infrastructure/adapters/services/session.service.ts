import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    ISessionRepository,
    SESSION_REPOSITORY_TOKEN,
} from '@/core/domain/automation/contracts/session.repository.contracts';
import { ISessionService } from '@/core/domain/automation/contracts/session.service.contracts';
import { SessionEntity } from '@/core/domain/automation/entities/session.entity';
import { ISession } from '@/core/domain/automation/interfaces/session.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class SessionService implements ISessionService {
    constructor(
        @Inject(SESSION_REPOSITORY_TOKEN)
        private readonly sessionRepository: ISessionRepository,
    ) {}
    findOne(filter?: Partial<ISession>): Promise<SessionEntity> {
        return this.sessionRepository.findOne(filter);
    }

    create(session: Omit<ISession, 'uuid'>): Promise<SessionEntity> {
        return this.sessionRepository.create(session);
    }
    update(
        filter: Partial<ISession>,
        data: Partial<ISession>,
    ): Promise<SessionEntity> {
        return this.sessionRepository.update(filter, data);
    }
    delete(uuid: string): Promise<void> {
        return this.sessionRepository.delete(uuid);
    }
    findById(uuid: string): Promise<SessionEntity> {
        return this.sessionRepository.findById(uuid);
    }
    find(filter?: Partial<ISession>): Promise<SessionEntity[]> {
        return this.sessionRepository.find(filter);
    }
    getNativeCollection() {
        return this.sessionRepository.getNativeCollection();
    }

    register(session: Omit<ISession, 'uuid'>): Promise<SessionEntity> {
        return this.create({ ...session });
    }

    async checkIfHasActiveSessions(
        platformUserId: string,
        organizationAndTeamData?: OrganizationAndTeamData,
    ): Promise<SessionEntity> {
        try {
            let sessions = null;

            if (
                organizationAndTeamData &&
                organizationAndTeamData?.organizationId &&
                organizationAndTeamData?.teamId
            ) {
                sessions = await this.find({
                    platformUserId: platformUserId,
                    organizationId: organizationAndTeamData?.organizationId,
                    teamId: organizationAndTeamData?.teamId,
                });
            } else {
                sessions = await this.find({
                    platformUserId: platformUserId,
                });
            }

            if (!sessions || sessions.length <= 0) {
                return null;
            }

            // Finds the most recent session
            const latestSession = sessions.reduce(
                (latest, session) =>
                    !latest || session.date > latest.date ? session : latest,
                null as SessionEntity | null,
            );

            const SESSION_LIMIT = 60 * 60 * 1000; // 60 minutes in milliseconds

            if (Date.now() - (latestSession?.date || 0) > SESSION_LIMIT) {
                return null;
            }

            return latestSession;
        } catch (error) {
            console.error(error);
        }
    }
}
