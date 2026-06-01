import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IRepositoryRepository } from '@libs/code-review/domain/contracts/RepositoryRepository.contract';

import { RepositoryModel, AstGraphStatus } from './schemas/repository.model';

@Injectable()
export class RepositoryRepository implements IRepositoryRepository {
    constructor(
        @InjectRepository(RepositoryModel)
        private readonly repo: Repository<RepositoryModel>,
    ) {}

    /**
     * Find or create a repository record.
     * Looks up by (platform, externalId). If not found, creates with status PENDING.
     */
    async findOrCreate(params: {
        integrationConfigId: string;
        externalId: string;
        name: string;
        fullName: string;
        platform: string;
        defaultBranch?: string;
    }): Promise<RepositoryModel> {
        const existing = await this.repo.findOne({
            where: {
                platform: params.platform,
                externalId: params.externalId,
            },
        });

        if (existing) {
            return existing;
        }

        try {
            const model = this.repo.create({
                integrationConfigId: params.integrationConfigId,
                externalId: params.externalId,
                name: params.name,
                fullName: params.fullName,
                platform: params.platform,
                defaultBranch: params.defaultBranch ?? 'main',
                astGraphStatus: AstGraphStatus.PENDING,
            });

            return await this.repo.save(model);
        } catch (error: any) {
            // Handle race condition: concurrent insert hit unique constraint
            if (
                error?.code === '23505' ||
                error?.message?.includes('duplicate key')
            ) {
                const retry = await this.repo.findOne({
                    where: {
                        platform: params.platform,
                        externalId: params.externalId,
                    },
                });
                if (retry) return retry;
            }
            throw error;
        }
    }

    /**
     * Find by platform + external ID.
     */
    async findByExternalId(
        platform: string,
        externalId: string,
    ): Promise<RepositoryModel | null> {
        return this.repo.findOne({
            where: { platform, externalId },
        });
    }

    /**
     * Find by internal UUID.
     */
    async findById(uuid: string): Promise<RepositoryModel | null> {
        return this.repo.findOne({ where: { uuid } });
    }

    /**
     * Update graph build status and optional metadata.
     * Sets astGraphBuiltAt = now() when status transitions to READY.
     */
    async updateGraphStatus(
        uuid: string,
        status: AstGraphStatus,
        extra?: {
            sha?: string;
            nodeCount?: number;
            edgeCount?: number;
        },
    ): Promise<void> {
        const update: Partial<RepositoryModel> = {
            astGraphStatus: status,
        };

        if (extra?.sha !== undefined) {
            update.astGraphSha = extra.sha;
        }
        if (extra?.nodeCount !== undefined) {
            update.astGraphNodeCount = extra.nodeCount;
        }
        if (extra?.edgeCount !== undefined) {
            update.astGraphEdgeCount = extra.edgeCount;
        }
        if (status === AstGraphStatus.READY) {
            update.astGraphBuiltAt = new Date();
        }

        await this.repo.update({ uuid }, update);
    }
}
