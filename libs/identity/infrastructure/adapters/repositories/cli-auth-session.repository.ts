import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsSelect, LessThan, Repository } from 'typeorm';

import { ICliAuthSessionRepository } from '@libs/identity/domain/cli-auth/contracts/cli-auth-session.repository';
import {
    CompleteCliAuthSession,
    CreateCliAuthSession,
    ICliAuthSession,
} from '@libs/identity/domain/cli-auth/interfaces/cli-auth-session.interface';

import { CliAuthSessionModel } from './schemas/cli-auth-session.model';

/**
 * Explicit projection for every read of `cli_auth_sessions` — keeps the
 * SQL focused on what `toInterface` actually needs and, for the joined
 * `user` relation, brings only `uuid` instead of the entire row. Without
 * this, `findOne({ relations: ['user'] })` issues a `SELECT *` join that
 * pulls password hashes and other heavy user columns we never read here.
 */
const SESSION_SELECT: FindOptionsSelect<CliAuthSessionModel> = {
    uuid: true,
    state: true,
    deviceCode: true,
    userCode: true,
    redirectUri: true,
    mode: true,
    status: true,
    accessToken: true,
    refreshToken: true,
    userEmail: true,
    userAgent: true,
    expiresAt: true,
    consumedAt: true,
    completedAt: true,
    createdAt: true,
    updatedAt: true,
    user: { uuid: true },
};

@Injectable()
export class CliAuthSessionRepository implements ICliAuthSessionRepository {
    constructor(
        @InjectRepository(CliAuthSessionModel)
        private readonly repo: Repository<CliAuthSessionModel>,
    ) {}

    private toInterface(model: CliAuthSessionModel): ICliAuthSession {
        return {
            uuid: model.uuid,
            state: model.state,
            deviceCode: model.deviceCode ?? null,
            userCode: model.userCode ?? null,
            redirectUri: model.redirectUri ?? null,
            mode: model.mode,
            status: model.status,
            accessToken: model.accessToken ?? null,
            refreshToken: model.refreshToken ?? null,
            userId: model.user?.uuid ?? null,
            userEmail: model.userEmail ?? null,
            userAgent: model.userAgent ?? null,
            expiresAt: model.expiresAt,
            consumedAt: model.consumedAt ?? null,
            completedAt: model.completedAt ?? null,
            createdAt: model.createdAt,
            updatedAt: model.updatedAt,
        };
    }

    async create(input: CreateCliAuthSession): Promise<ICliAuthSession> {
        const model = this.repo.create({
            state: input.state,
            mode: input.mode,
            expiresAt: input.expiresAt,
            redirectUri: input.redirectUri ?? null,
            deviceCode: input.deviceCode ?? null,
            userCode: input.userCode ?? null,
            userAgent: input.userAgent ?? null,
            status: 'pending',
        });
        const saved = await this.repo.save(model);
        return this.toInterface(saved);
    }

    async findByState(state: string): Promise<ICliAuthSession | null> {
        const model = await this.repo.findOne({
            where: { state },
            relations: ['user'],
            select: SESSION_SELECT,
        });
        return model ? this.toInterface(model) : null;
    }

    async findByDeviceCode(
        deviceCode: string,
    ): Promise<ICliAuthSession | null> {
        const model = await this.repo.findOne({
            where: { deviceCode },
            relations: ['user'],
            select: SESSION_SELECT,
        });
        return model ? this.toInterface(model) : null;
    }

    async findByUserCode(userCode: string): Promise<ICliAuthSession | null> {
        const model = await this.repo.findOne({
            where: { userCode, status: 'pending' },
            relations: ['user'],
            select: SESSION_SELECT,
        });
        return model ? this.toInterface(model) : null;
    }

    async complete(
        uuid: string,
        data: CompleteCliAuthSession,
    ): Promise<ICliAuthSession | null> {
        await this.repo.update(
            { uuid },
            {
                accessToken: data.accessToken ?? null,
                refreshToken: data.refreshToken ?? null,
                userEmail: data.userEmail ?? null,
                user: data.userId ? ({ uuid: data.userId } as any) : null,
                status: 'completed',
                completedAt: new Date(),
            },
        );

        const updated = await this.repo.findOne({
            where: { uuid },
            relations: ['user'],
            select: SESSION_SELECT,
        });
        return updated ? this.toInterface(updated) : null;
    }

    async markConsumed(uuid: string): Promise<void> {
        await this.repo.update(
            { uuid },
            { status: 'consumed', consumedAt: new Date() },
        );
    }

    async markDenied(uuid: string): Promise<void> {
        await this.repo.update({ uuid }, { status: 'denied' });
    }

    async expirePending(now: Date): Promise<number> {
        const result = await this.repo.update(
            { status: 'pending', expiresAt: LessThan(now) },
            { status: 'expired' },
        );
        return result.affected ?? 0;
    }
}
