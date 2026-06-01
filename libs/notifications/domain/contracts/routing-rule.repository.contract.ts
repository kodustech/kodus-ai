import { IRoutingRule } from '../interfaces/routing-rule.interface';

export interface IRoutingRuleRepository {
    findByOrganization(organizationId: string): Promise<IRoutingRule[]>;

    /**
     * Resolve the routing rule for a specific (org, event, role) tuple.
     * Falls back through the wildcard-role chain:
     *   1. (org, event, role)  — per-role override
     *   2. (org, event, '*')   — All Roles config
     *   3. null                — caller uses catalog defaults
     */
    resolve(
        organizationId: string,
        event: string,
        role: string,
    ): Promise<IRoutingRule | null>;

    upsert(rule: Omit<IRoutingRule, 'uuid' | 'createdAt' | 'updatedAt'>): Promise<IRoutingRule>;

    upsertBatch(
        rules: Array<Omit<IRoutingRule, 'uuid' | 'createdAt' | 'updatedAt'>>,
    ): Promise<IRoutingRule[]>;

    deleteByOrganization(organizationId: string): Promise<number>;

    /**
     * Remove a single (org, event, role) routing rule. Used to revert a
     * per-role override so the rule falls back to the wildcard config.
     * Returns the number of rows affected (0 or 1).
     */
    deleteByOrgEventRole(
        organizationId: string,
        event: string,
        role: string,
    ): Promise<number>;
}

export const ROUTING_RULE_REPOSITORY_TOKEN = Symbol.for(
    'RoutingRuleRepository',
);
