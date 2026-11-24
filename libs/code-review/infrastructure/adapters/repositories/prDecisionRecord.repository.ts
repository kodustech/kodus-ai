import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
    PrDecisionApplyOutcomeJson,
    PrDecisionGateVerdictsJson,
    PrDecisionRecordModel,
} from './schemas/prDecisionRecord.model';

/**
 * The reconciler's source-of-truth row. Composite key
 * (repositoryId, prNumber, headSha) is unique-indexed; concurrent reconciles
 * for the same head_sha hit the unique constraint and the second one
 * short-circuits to "no change" (per design.md §Migration step 4).
 */
@Injectable()
export class PrDecisionRecordRepository {
    constructor(
        @InjectRepository(PrDecisionRecordModel)
        private readonly repo: Repository<PrDecisionRecordModel>,
    ) {}

    async findByRecordKey(input: {
        organizationId: string;
        repositoryId: string;
        prNumber: number;
        headSha: string;
    }): Promise<PrDecisionRecordModel | null> {
        return this.repo.findOne({
            where: {
                organizationId: input.organizationId,
                repositoryId: input.repositoryId,
                prNumber: input.prNumber,
                headSha: input.headSha,
            },
        });
    }

    async upsert(input: {
        organizationId: string;
        repositoryId: string;
        prNumber: number;
        headSha: string;
        baseSha: string;
        configurationKey: string;
        gateVerdictsSnapshot: PrDecisionGateVerdictsJson;
        lastApplyOutcome: PrDecisionApplyOutcomeJson;
        lastReconciledAt: Date;
        consecutiveFailures?: number;
        inFlightTriggerKind?: string | null;
    }): Promise<PrDecisionRecordModel> {
        const existing = await this.repo.findOne({
            where: {
                organizationId: input.organizationId,
                repositoryId: input.repositoryId,
                prNumber: input.prNumber,
                headSha: input.headSha,
            },
        });

        if (existing) {
            this.repo.merge(existing, {
                baseSha: input.baseSha,
                configurationKey: input.configurationKey,
                gateVerdictsSnapshot: input.gateVerdictsSnapshot,
                lastApplyOutcome: input.lastApplyOutcome,
                lastReconciledAt: input.lastReconciledAt,
                consecutiveFailures: input.consecutiveFailures ?? 0,
                inFlightTriggerKind: input.inFlightTriggerKind ?? null,
            });
            return this.repo.save(existing);
        }

        const created = this.repo.create({
            organizationId: input.organizationId,
            repositoryId: input.repositoryId,
            prNumber: input.prNumber,
            headSha: input.headSha,
            baseSha: input.baseSha,
            configurationKey: input.configurationKey,
            gateVerdictsSnapshot: input.gateVerdictsSnapshot,
            lastApplyOutcome: input.lastApplyOutcome,
            lastReconciledAt: input.lastReconciledAt,
            consecutiveFailures: input.consecutiveFailures ?? 0,
            inFlightTriggerKind: input.inFlightTriggerKind ?? null,
        });
        return this.repo.save(created);
    }

    async update(outdated: PrDecisionRecordModel): Promise<PrDecisionRecordModel> {
        return this.repo.save(outdated);
    }

    async requireByRecordKey(input: {
        organizationId: string;
        repositoryId: string;
        prNumber: number;
        headSha: string;
    }): Promise<PrDecisionRecordModel> {
        const found = await this.findByRecordKey(input);
        if (!found) {
            throw new NotFoundException(
                `No pr_decision_records row for ${input.repositoryId}#${input.prNumber}@${input.headSha}`,
            );
        }
        return found;
    }
}
