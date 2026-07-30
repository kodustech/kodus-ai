import { KodyRulesEntity } from '../entities/kodyRules.entity';
import {
    IKodyRule,
    IKodyRules,
    KodyRulesStatus,
} from '../interfaces/kodyRules.interface';

export const KODY_RULES_REPOSITORY_TOKEN = Symbol.for('KodyRulesRepository');

export interface IKodyRulesRepository {
    getNativeCollection(): any;

    create(
        kodyRules: Omit<IKodyRules, 'uuid'>,
    ): Promise<KodyRulesEntity | null>;

    findById(uuid: string): Promise<IKodyRule | null>;
    findOne(filter?: Partial<IKodyRules>): Promise<KodyRulesEntity | null>;
    find(filter?: Partial<IKodyRules>): Promise<KodyRulesEntity[]>;
    /** Projected list of org ids that have ≥1 rule — avoids loading every
     *  org's full embedded rules array (used by the detector sweep). */
    findOrganizationIdsWithRules(): Promise<string[]>;
    findByOrganizationId(
        organizationId: string,
    ): Promise<KodyRulesEntity | null>;

    /**
     * Count rules for an organization matching an optional status.
     * Implemented server-side via aggregation so callers don't need
     * to load the full embedded rules array just to read a number.
     */
    countRules(
        organizationId: string,
        status?: KodyRulesStatus,
    ): Promise<number>;

    /**
     * Counts rules per (repositoryId, directoryId) for an organization in a
     * single aggregation. Replaces fetching every repo's full rules array
     * client-side just to read a `.length` per card. `directoryId` is null
     * for repository-level rules.
     */
    countRulesByRepository(
        organizationId: string,
        statuses: KodyRulesStatus[],
    ): Promise<
        Array<{
            repositoryId: string;
            directoryId: string | null;
            count: number;
        }>
    >;

    update(
        uuid: string,
        updateData: Partial<IKodyRules>,
    ): Promise<KodyRulesEntity | null>;

    delete(uuid: string): Promise<boolean>;

    addRule(
        uuid: string,
        newRule: Partial<IKodyRule>,
    ): Promise<KodyRulesEntity | null>;
    updateRule(
        uuid: string,
        ruleId: string,
        updateData: Partial<IKodyRule>,
    ): Promise<KodyRulesEntity | null>;
    deleteRule(uuid: string, ruleId: string): Promise<boolean>;
    deleteRuleLogically(
        uuid: string,
        ruleId: string,
    ): Promise<KodyRulesEntity | null>;
    updateRulesStatusByFilter(
        organizationId: string,
        repositoryId: string,
        directoryId?: string,
        newStatus?: KodyRulesStatus,
    ): Promise<KodyRulesEntity | null>;
}
