import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { mapSimpleModelToEntity } from '@libs/core/infrastructure/repositories/mappers';

import {
    IRoutingRuleRepository,
} from '../../domain/contracts/routing-rule.repository.contract';
import { IRoutingRule } from '../../domain/interfaces/routing-rule.interface';
import { RoutingRuleEntity } from '../../domain/entities/routing-rule.entity';
import { RoutingRuleModel } from './schemas/routing-rule.model';

@Injectable()
export class RoutingRuleRepository implements IRoutingRuleRepository {
    constructor(
        @InjectRepository(RoutingRuleModel)
        private readonly repo: Repository<RoutingRuleModel>,
    ) {}

    async findByOrganization(organizationId: string): Promise<IRoutingRule[]> {
        const rows = await this.repo.find({
            where: { organization: { uuid: organizationId } },
            order: { event: 'ASC', role: 'ASC' },
        });
        return rows.map(
            (r) =>
                mapSimpleModelToEntity<RoutingRuleModel, RoutingRuleEntity>(
                    r,
                    RoutingRuleEntity,
                ).toObject(),
        );
    }

    /**
     * Resolve routing for (org, event, role) with wildcard-role fallback:
     *   1. Per-role override:    (org, event, role)
     *   2. All Roles ('*'):      (org, event, '*')
     *   3. Otherwise:            null  (caller falls back to catalog defaults)
     *
     * Event names are always concrete — no wildcard-event support.
     */
    async resolve(
        organizationId: string,
        event: string,
        role: string,
    ): Promise<IRoutingRule | null> {
        const orgWhere = { organization: { uuid: organizationId } };

        const specific = await this.repo.findOne({
            where: { ...orgWhere, event, role },
        });
        if (specific) {
            return mapSimpleModelToEntity<RoutingRuleModel, RoutingRuleEntity>(
                specific,
                RoutingRuleEntity,
            ).toObject();
        }

        const wildcard = await this.repo.findOne({
            where: { ...orgWhere, event, role: '*' },
        });
        if (wildcard) {
            return mapSimpleModelToEntity<RoutingRuleModel, RoutingRuleEntity>(
                wildcard,
                RoutingRuleEntity,
            ).toObject();
        }

        return null;
    }

    async upsert(
        rule: Omit<IRoutingRule, 'uuid' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRoutingRule> {
        const existing = await this.repo.findOne({
            where: {
                organization: { uuid: rule.organization?.uuid },
                event: rule.event,
                role: rule.role,
            },
        });

        if (existing) {
            existing.channels = rule.channels;
            existing.category = rule.category;
            const saved = await this.repo.save(existing);
            return mapSimpleModelToEntity<RoutingRuleModel, RoutingRuleEntity>(
                saved,
                RoutingRuleEntity,
            ).toObject();
        }

        const entity = this.repo.create({
            organization: rule.organization
                ? { uuid: rule.organization.uuid }
                : undefined,
            event: rule.event,
            category: rule.category,
            role: rule.role,
            channels: rule.channels,
        });
        const saved = await this.repo.save(entity);
        return mapSimpleModelToEntity<RoutingRuleModel, RoutingRuleEntity>(
            saved,
            RoutingRuleEntity,
        ).toObject();
    }

    async upsertBatch(
        rules: Array<Omit<IRoutingRule, 'uuid' | 'createdAt' | 'updatedAt'>>,
    ): Promise<IRoutingRule[]> {
        const results: IRoutingRule[] = [];
        for (const rule of rules) {
            results.push(await this.upsert(rule));
        }
        return results;
    }

    async deleteByOrganization(organizationId: string): Promise<number> {
        const result = await this.repo.delete({
            organization: { uuid: organizationId },
        });
        return result.affected ?? 0;
    }

    async deleteByOrgEventRole(
        organizationId: string,
        event: string,
        role: string,
    ): Promise<number> {
        const result = await this.repo.delete({
            organization: { uuid: organizationId },
            event,
            role,
        });
        return result.affected ?? 0;
    }
}
