import { KodyRulesEntity } from '../entities/kodyRules.entity';
import { IKodyRule, IKodyRules } from '../interfaces/kodyRules.interface';

export const KODY_RULES_REPOSITORY_TOKEN = Symbol('KodyRulesRepository');

export interface IKodyRulesRepository {
    getNativeCollection(): any;

    create(
        kodyRules: Omit<IKodyRules, 'uuid'>,
    ): Promise<KodyRulesEntity | null>;

    findById(uuid: string): Promise<KodyRulesEntity | null>;
    findOne(filter?: Partial<IKodyRules>): Promise<KodyRulesEntity | null>;
    find(filter?: Partial<IKodyRules>): Promise<KodyRulesEntity[]>;
    findByOrganizationId(
        organizationId: string,
    ): Promise<KodyRulesEntity | null>;

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
    deleteRule(uuid: string, ruleId: string): Promise<Boolean>;
    deleteRuleLogically(
        uuid: string,
        ruleId: string,
    ): Promise<KodyRulesEntity | null>;
}
