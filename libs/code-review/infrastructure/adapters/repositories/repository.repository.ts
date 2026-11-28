import { AST_GRAPH_BUILD_TIMEOUT_MS } from '@libs/code-review/domain/graph-job-attempt';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IRepositoryRepository } from '@libs/code-review/domain/contracts/RepositoryRepository.contract';

import { RepositoryModel, AstGraphStatus } from './schemas/repository.model';

const LOCK_NOT_AVAILABLE = '55P03';
const DEFER_LOCK_WAIT_MS = 500;
const DEFER_RETRY_DELAY_MS = 2000;
const DEFER_STATEMENT_TIMEOUT_MS = 10_000;

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

    async deferMergeDuringBuild(
        uuid: string,
        mergeSha: string | undefined,
    ): Promise<boolean> {
        // Conditional on BUILDING so a build that just published sends the
        // caller back to the normal incremental path. Webhooks can arrive out
        // of order, so two different merges become '' (unknown), which always
        // gets a catch-up instead of trusting whichever landed last.
        // A full build holds this row locked while it writes its rows, which on
        // a large graph outlasts the statement timeout. Wait in short attempts
        // that give the connection back between them, for as long as the
        // build may run, so the merge is neither dropped nor pins a connection.
        const deadline = Date.now() + AST_GRAPH_BUILD_TIMEOUT_MS;
        for (;;) {
            try {
                return await this.repo.manager.transaction(async (manager) => {
                    // The statement limit sits above the lock wait, so a short
                    // global statement timeout cannot fire first and drop it.
                    await manager.query(
                        `SET LOCAL lock_timeout = ${DEFER_LOCK_WAIT_MS}`,
                    );
                    await manager.query(
                        `SET LOCAL statement_timeout = ${DEFER_STATEMENT_TIMEOUT_MS}`,
                    );
                    const result = await manager
                        .createQueryBuilder(RepositoryModel, 'repository')
                        .update()
                        .set({
                            astGraphMergedDuringBuild: () =>
                                `CASE WHEN ast_graph_merged_during_build IS NULL OR ast_graph_merged_during_build = :sha THEN :sha ELSE '' END`,
                        })
                        .where(
                            'uuid = :uuid AND ast_graph_status = :building',
                            { uuid, building: AstGraphStatus.BUILDING },
                        )
                        .setParameter('sha', mergeSha ?? '')
                        .execute();
                    return !!result.affected;
                });
            } catch (error) {
                const code = error?.driverError?.code ?? error?.code;
                if (code !== LOCK_NOT_AVAILABLE || Date.now() >= deadline)
                    throw error;
                await new Promise((resolve) =>
                    setTimeout(resolve, DEFER_RETRY_DELAY_MS),
                );
            }
        }
    }

    async clearMergeDeferredDuringBuild(
        uuid: string,
        mergeSha: string,
    ): Promise<void> {
        await this.repo.update(
            { uuid, astGraphMergedDuringBuild: mergeSha },
            { astGraphMergedDuringBuild: null },
        );
    }
}
