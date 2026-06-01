import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, MoreThan, Repository } from 'typeorm';
import {
    CreateSSOTestSessionPayload,
    ISSOTestSessionRepository,
    UpdateSSOTestSessionStatusPayload,
} from '../domain/contracts/ssoTestSession.repository.contract';
import {
    SSOConnectionTestSession,
    SSOProtocol,
} from '../domain/interfaces/ssoConfig.interface';
import { SSOTestSessionModel } from './ssoTestSession.model';
import { mapSimpleModelToEntity } from '@libs/core/infrastructure/repositories/mappers';
import { SSOTestSessionEntity } from '../domain/entities/ssoTestSession.entity';

@Injectable()
export class SSOTestSessionRepository implements ISSOTestSessionRepository {
    constructor(
        @InjectRepository(SSOTestSessionModel)
        private readonly ssoTestSessionRepository: Repository<SSOTestSessionModel>,
    ) {}

    async create<P extends SSOProtocol>(
        payload: CreateSSOTestSessionPayload<P>,
    ): Promise<SSOConnectionTestSession<P>> {
        const model = this.ssoTestSessionRepository.create({
            sessionId: payload.sessionId,
            protocol: payload.protocol,
            status: payload.status,
            configFingerprint: payload.configFingerprint,
            providerConfig: payload.providerConfig,
            domains: payload.domains,
            createdBy: payload.createdBy,
            testedAt: payload.testedAt,
            failureCode: payload.failureCode,
            failureMessage: payload.failureMessage,
            expiresAt: payload.expiresAt,
            organization: {
                uuid: payload.organizationId,
            },
        });

        const saved = await this.ssoTestSessionRepository.save(model);

        return mapSimpleModelToEntity(saved, SSOTestSessionEntity);
    }

    async findValidBySessionId<P extends SSOProtocol>(
        sessionId: string,
    ): Promise<SSOConnectionTestSession<P> | null> {
        const model = await this.findValidModelBySessionId(sessionId);

        if (!model) {
            return null;
        }

        return mapSimpleModelToEntity(model, SSOTestSessionEntity);
    }

    async updateStatus<P extends SSOProtocol>(
        sessionId: string,
        payload: UpdateSSOTestSessionStatusPayload,
    ): Promise<SSOConnectionTestSession<P> | null> {
        const model = await this.findValidModelBySessionId(sessionId);

        if (!model) {
            return null;
        }

        model.status = payload.status;
        model.testedAt = payload.testedAt;
        model.failureCode = payload.failureCode;
        model.failureMessage = payload.failureMessage;

        const saved = await this.ssoTestSessionRepository.save(model);

        return mapSimpleModelToEntity(saved, SSOTestSessionEntity);
    }

    async purgeExpired(referenceDate: Date): Promise<number> {
        const deleted = await this.ssoTestSessionRepository.delete({
            expiresAt: LessThanOrEqual(referenceDate),
        });

        return deleted.affected || 0;
    }

    private async findValidModelBySessionId(
        sessionId: string,
    ): Promise<SSOTestSessionModel | null> {
        return this.ssoTestSessionRepository.findOne({
            where: {
                sessionId,
                expiresAt: MoreThan(new Date()),
            },
            relations: ['organization'],
        });
    }
}
