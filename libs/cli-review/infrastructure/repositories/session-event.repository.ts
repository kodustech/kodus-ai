import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    SessionEventModel,
    ClassificationSource,
} from './schemas/session-event.model';
import { CliSessionClassifiedDecision } from '@libs/cli-review/domain/types/cli-session-capture.types';

@Injectable()
export class SessionEventRepository {
    constructor(
        @InjectRepository(SessionEventModel)
        private readonly repo: Repository<SessionEventModel>,
    ) {}

    async create(data: Partial<SessionEventModel>): Promise<SessionEventModel> {
        const model = this.repo.create(data);
        return this.repo.save(model);
    }

    async findByUuid(uuid: string): Promise<SessionEventModel | null> {
        return this.repo.findOne({ where: { uuid } });
    }

    async findBySessionId(
        sessionId: string,
        organizationId: string,
    ): Promise<SessionEventModel[]> {
        return this.repo.find({
            where: { sessionId, organizationId },
            order: { eventTimestamp: 'ASC' },
        });
    }

    async markClassificationProcessing(uuid: string): Promise<void> {
        await this.repo.update(uuid, {
            classificationStatus: 'PROCESSING',
        });
    }

    async markClassificationCompleted(
        uuid: string,
        decisions: CliSessionClassifiedDecision[],
        source: ClassificationSource,
    ): Promise<void> {
        await this.repo.update(uuid, {
            classificationStatus: 'COMPLETED',
            decisions,
            classificationSource: source,
            classifiedAt: new Date(),
        });
    }

    async markClassificationFailed(
        uuid: string,
        errorMessage: string,
    ): Promise<void> {
        await this.repo.update(uuid, {
            classificationStatus: 'FAILED',
            classificationError: errorMessage,
            classifiedAt: new Date(),
        });
    }

    async markClassificationSkipped(
        uuid: string,
        reason: string,
    ): Promise<void> {
        await this.repo.update(uuid, {
            classificationStatus: 'SKIPPED',
            classificationError: reason,
            classifiedAt: new Date(),
        });
    }

    /**
     * Finds sessions that have no session_end event, no classification,
     * and whose last event is older than the given threshold.
     *
     * Uses a subquery to retrieve branch and teamId from the latest event
     * (instead of MIN aggregates) so metadata is always consistent.
     */
    async findOrphanedSessions(
        inactivityMinutes: number,
        limit: number,
    ): Promise<
        Array<{
            sessionId: string;
            organizationId: string;
            teamId: string;
            branch: string;
            lastEventTimestamp: Date;
        }>
    > {
        const threshold = new Date(Date.now() - inactivityMinutes * 60 * 1000);

        // Step 1: find (sessionId, organizationId) with max timestamp < threshold,
        // no session_end, and no classification.
        const candidates = this.repo
            .createQueryBuilder('se')
            .select('se.session_id', 'sessionId')
            .addSelect('se.organization_id', 'organizationId')
            .addSelect('MAX(se.event_timestamp)', 'lastEventTimestamp')
            .where(
                `NOT EXISTS (
                    SELECT 1 FROM session_events se2
                    WHERE se2.session_id = se.session_id
                    AND se2.organization_id = se.organization_id
                    AND se2.type = 'session_end'
                )`,
            )
            .andWhere(
                `NOT EXISTS (
                    SELECT 1 FROM session_events se3
                    WHERE se3.session_id = se.session_id
                    AND se3.organization_id = se.organization_id
                    AND se3.classification_status IS NOT NULL
                )`,
            )
            .groupBy('se.session_id')
            .addGroupBy('se.organization_id')
            .having('MAX(se.event_timestamp) < :threshold', { threshold })
            .orderBy('MAX(se.event_timestamp)', 'ASC')
            .limit(limit);

        const rawCandidates = await candidates.getRawMany();

        if (!rawCandidates.length) {
            return [];
        }

        // Step 2: for each candidate, fetch branch and teamId from the latest event.
        const results: Array<{
            sessionId: string;
            organizationId: string;
            teamId: string;
            branch: string;
            lastEventTimestamp: Date;
        }> = [];

        for (const c of rawCandidates) {
            const latestEvent = await this.repo.findOne({
                where: {
                    sessionId: c.sessionId,
                    organizationId: c.organizationId,
                },
                order: { eventTimestamp: 'DESC' },
            });

            results.push({
                sessionId: c.sessionId,
                organizationId: c.organizationId,
                teamId: latestEvent?.teamId ?? c.organizationId,
                branch: latestEvent?.branch ?? 'unknown',
                lastEventTimestamp: new Date(c.lastEventTimestamp),
            });
        }

        return results;
    }

    /**
     * Finds synthetic session_end events that were created by the orphaned
     * sessions cron but never classified (e.g. due to a crash between
     * creating the event and running classification).
     */
    async findUnclassifiedSyntheticEnds(
        limit: number,
    ): Promise<SessionEventModel[]> {
        return this.repo
            .createQueryBuilder('se')
            .where("se.type = 'session_end'")
            .andWhere("se.payload->>'synthetic' = 'true'")
            .andWhere('se.classification_status IS NULL')
            .orderBy('se.event_timestamp', 'ASC')
            .limit(limit)
            .getMany();
    }
}
