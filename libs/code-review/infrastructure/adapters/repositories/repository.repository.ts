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
     * If found but the integrationConfigId differs from the passed value, heals
     * the stale FK so previously-mislinked rows (e.g. created with a team id
     * instead of an integration_config id) self-repair on the next onboarding
     * save rather than requiring a manual data backfill.
     *
     * The heal is gated on the stored value being dangling: `repositories` is
     * globally unique on (platform, externalId) with no org/team filter in
     * this lookup, and the owning team is derived solely from this FK. A row
     * still linked to a live `integration_configs` row may belong to another
     * team — overwriting it would steal the repo row and break that team's
     * webhook join. We therefore only overwrite when the stored value no
     * longer resolves to any `integration_configs` row.
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
            if (
                existing.integrationConfigId &&
                existing.integrationConfigId !== params.integrationConfigId
            ) {
                // Heal only a dangling FK (e.g. a stale team id written by
                // the old call sites). A row still linked to a live
                // integration_configs row may belong to another team, and
                // (platform, externalId) is globally unique — overwriting
                // it would steal the repo row and break that team's
                // repositories -> integration_configs webhook join.
                const [stale] = await this.repo.query(
                    `SELECT NOT EXISTS (
                         SELECT 1 FROM integration_configs ic
                          WHERE ic.uuid = $1
                     ) AS stale`,
                    [existing.integrationConfigId],
                );
                if (stale?.stale) {
                    await this.repo.update(
                        { uuid: existing.uuid },
                        { integrationConfigId: params.integrationConfigId },
                    );
                    existing.integrationConfigId = params.integrationConfigId;
                }
            }
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
