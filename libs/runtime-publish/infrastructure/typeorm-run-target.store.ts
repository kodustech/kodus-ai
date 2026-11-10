import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { RunTargetConflictError, sameRunTarget, type RunTarget, type RunTargetStore } from '../domain/run-target';
import { RuntimeRunTargetModel } from './runtime-run-target.model';

const UNIQUE_VIOLATION = '23505';

@Injectable()
export class TypeOrmRunTargetStore implements RunTargetStore {
    constructor(
        @InjectRepository(RuntimeRunTargetModel)
        private readonly repo: Repository<RuntimeRunTargetModel>,
    ) {}

    async record(target: RunTarget): Promise<void> {
        try {
            await this.repo.insert({ ...target, repositoryFullName: target.repositoryFullName ?? null });
        } catch (error) {
            const code = (error as { code?: string; driverError?: { code?: string } })?.code ?? (error as any)?.driverError?.code;
            if (code !== UNIQUE_VIOLATION) throw error;
            // A redelivered enqueue of the same Run is fine; another target never replaces the first.
            const existing = await this.get(target.runId);
            if (!existing || !sameRunTarget(existing, target)) throw new RunTargetConflictError(target.runId);
        }
    }

    async get(runId: string): Promise<RunTarget | null> {
        const row = await this.repo.findOne({ where: { runId } });
        if (!row) return null;
        return {
            runId: row.runId,
            attempt: row.attempt,
            organizationId: row.organizationId,
            teamId: row.teamId,
            repositoryId: row.repositoryId,
            repositoryName: row.repositoryName,
            ...(row.repositoryFullName ? { repositoryFullName: row.repositoryFullName } : {}),
            platform: row.platform as PlatformType,
            pullRequestNumber: row.pullRequestNumber,
            headSha: row.headSha,
        };
    }
}
