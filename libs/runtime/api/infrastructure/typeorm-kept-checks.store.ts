import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import type { KeptCheckRecord, KeptCheckStore } from '../domain/ports';
import { RuntimeKeptCheckModel } from './runtime-product.models';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toRecord = (m: RuntimeKeptCheckModel): KeptCheckRecord => ({
    keptCheckId: m.uuid,
    organizationId: m.organizationId,
    environmentId: m.environmentId,
    repositoryId: m.repositoryId,
    probeKey: m.probeKey,
    entryPoint: m.entryPoint,
    probe: m.check.probe,
    ...(m.check.assertions ? { assertions: m.check.assertions } : {}),
    differingFields: m.check.differingFields ?? [],
    sourceRunId: m.sourceRunId,
    sourceProbeId: m.sourceProbeId,
    sourcePrNumber: m.sourcePrNumber,
    keptBy: m.keptBy,
    keptAt: (m.createdAt instanceof Date ? m.createdAt : new Date(m.createdAt)).toISOString(),
});

/**
 * runtime_kept_checks (product Postgres, AddRuntimeKeptChecks2026111710000000),
 * written by the API. Every query filters on the org; a removed check is never
 * read back. One active check per key: the partial unique index decides a race
 * between two keeps of the same probe, and the loser reads the winner's row.
 */
export class TypeOrmKeptCheckStore implements KeptCheckStore {
    constructor(
        @InjectRepository(RuntimeKeptCheckModel)
        private readonly repo: Repository<RuntimeKeptCheckModel>,
    ) {}

    async listActive(organizationId: string, scope: { environmentId: string; repositoryId?: string }, limit: number): Promise<KeptCheckRecord[]> {
        const rows = await this.repo.find({
            where: { organizationId, environmentId: scope.environmentId, ...(scope.repositoryId ? { repositoryId: scope.repositoryId } : {}), removedAt: IsNull() },
            order: { createdAt: 'ASC', uuid: 'ASC' },
            take: limit,
        });
        return rows.map(toRecord);
    }

    async get(organizationId: string, keptCheckId: string): Promise<KeptCheckRecord | null> {
        if (!UUID.test(keptCheckId)) return null;
        const row = await this.repo.findOne({ where: { uuid: keptCheckId, organizationId, removedAt: IsNull() } });
        return row ? toRecord(row) : null;
    }

    async keep(input: Omit<KeptCheckRecord, 'keptCheckId' | 'keptAt'>, max: number): Promise<{ record: KeptCheckRecord; created: boolean } | { full: true }> {
        const scope = { organizationId: input.organizationId, environmentId: input.environmentId, repositoryId: input.repositoryId, removedAt: IsNull() };
        const same = () => this.repo.findOne({ where: { ...scope, probeKey: input.probeKey } });
        const existing = await same();
        if (existing) return { record: toRecord(existing), created: false };
        if ((await this.repo.count({ where: scope })) >= max) return { full: true };
        const inserted = await this.repo
            .createQueryBuilder()
            .insert()
            .values({
                organizationId: input.organizationId,
                environmentId: input.environmentId,
                repositoryId: input.repositoryId,
                probeKey: input.probeKey,
                entryPoint: input.entryPoint,
                check: { probe: input.probe, ...(input.assertions ? { assertions: input.assertions } : {}), differingFields: input.differingFields },
                sourceRunId: input.sourceRunId,
                sourceProbeId: input.sourceProbeId,
                sourcePrNumber: input.sourcePrNumber,
                keptBy: input.keptBy,
            })
            .orIgnore()
            .returning(['uuid'])
            .execute();
        const id = (inserted.raw as Array<{ uuid?: string }> | undefined)?.[0]?.uuid;
        const row = id ? await this.repo.findOne({ where: { uuid: id, organizationId: input.organizationId } }) : await same();
        if (!row) throw new Error('kept check vanished after insert');
        return { record: toRecord(row), created: !!id };
    }

    async remove(organizationId: string, keptCheckId: string, removedBy: string): Promise<boolean> {
        if (!UUID.test(keptCheckId)) return false;
        const result = await this.repo.update({ uuid: keptCheckId, organizationId, removedAt: IsNull() }, { removedAt: new Date(), removedBy });
        return (result.affected ?? 0) > 0;
    }
}
