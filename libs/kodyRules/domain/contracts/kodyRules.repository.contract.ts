import { KodyRulesEntity } from '../entities/kodyRules.entity';
import {
    IKodyRule,
    KodyRuleCompileInput,
    IKodyRuleIndexEntry,
    IKodyRules,
    KodyRulesStatus,
} from '../interfaces/kodyRules.interface';

export const KODY_RULES_REPOSITORY_TOKEN = Symbol.for('KodyRulesRepository');

export interface IKodyRulesRepository {
    getNativeCollection(): any;

    create(
        kodyRules: Omit<IKodyRules, 'uuid'>,
    ): Promise<KodyRulesEntity | null>;

    findById(uuid: string, organizationId: string): Promise<IKodyRule | null>;
    findOne(filter?: Partial<IKodyRules>): Promise<KodyRulesEntity | null>;
    find(filter?: Partial<IKodyRules>): Promise<KodyRulesEntity[]>;
    /** Projected list of org ids that have ≥1 rule — avoids loading every
     *  org's full embedded rules array (used by the detector sweep). */
    findOrganizationIdsWithRules(): Promise<string[]>;
    findByOrganizationId(
        organizationId: string,
    ): Promise<KodyRulesEntity | null>;
    /**
     * The organization's rules minus the deleted ones, filtered by the
     * server. For readers that never act on a deleted rule (the review):
     * deleted rules stay in the document and can be most of it.
     */
    findLiveRulesByOrganizationId(
        organizationId: string,
    ): Promise<KodyRulesEntity | null>;
    /**
     * Applies several per-rule field patches to one rules document in a
     * single round trip, each patch touching only its rule's fields. Returns
     * the ids whose patch could not be written.
     */
    updateRulesFields(
        organizationId: string,
        uuid: string,
        changes: Array<{ ruleId: string; patch: Partial<IKodyRule> }>,
    ): Promise<string[]>;

    /**
     * Projected list of an organization's rules — id, title and scope only.
     * Server-side projection so a picker never pulls every rule body, example
     * and detector out of Mongo just to show titles.
     */
    findRulesIndex(organizationId: string): Promise<IKodyRuleIndexEntry[]>;

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
    /**
     * Field-level `$set` on one rule, addressed by organization and rule id,
     * returning only that rule (never the whole organization document).
     * Undefined fields are skipped, `null` is written. Null when no document
     * of the organization holds the rule.
     */
    updateRuleFieldsByOrganization(
        organizationId: string,
        ruleId: string,
        updateData: Partial<IKodyRule>,
        expectedInput?: KodyRuleCompileInput,
    ): Promise<Partial<IKodyRule> | null>;
    /** Whether the organization has a Kody Rules document at all. */
    existsForOrganization(organizationId: string): Promise<boolean>;
    deleteRule(uuid: string, ruleId: string): Promise<boolean>;
    /** Marks the organization's rule deleted; true when the rule was found. */
    deleteRuleLogically(
        organizationId: string,
        ruleId: string,
    ): Promise<boolean>;
    /**
     * Stamps `digestedAt` on the rule's `autoPause` / `lastAutoPause` whose
     * `pausedAt` is one of `pausedAts`. Matching on `pausedAt` keeps a resume
     * or a new pause that landed after the read from being overwritten.
     */
    markAutoPausesDigested(
        organizationId: string,
        ruleId: string,
        pausedAts: Date[],
        digestedAt: Date,
    ): Promise<boolean>;
    updateRulesStatusByFilter(
        organizationId: string,
        repositoryId: string,
        directoryId?: string,
        newStatus?: KodyRulesStatus,
    ): Promise<KodyRulesEntity | null>;
}
