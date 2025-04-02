import { Entity } from '@/shared/domain/interfaces/entity';
import { IKodyRule, IKodyRules } from '../interfaces/kodyRules.interface';

export class KodyRulesEntity implements Entity<IKodyRules> {
    private readonly _uuid: string;
    private readonly _organizationId: string;
    private readonly _rules: Partial<IKodyRule>[];
    private readonly _createdAt: Date;
    private readonly _updatedAt: Date;

    constructor(kodyRules: IKodyRules) {
        this._uuid = kodyRules.uuid;
        this._organizationId = kodyRules.organizationId;
        this._rules = kodyRules.rules;
        this._createdAt = kodyRules.createdAt;
        this._updatedAt = kodyRules.updatedAt;
    }

    toJson(): IKodyRules {
        return {
            uuid: this._uuid,
            organizationId: this._organizationId,
            rules: this._rules,
            createdAt: this._createdAt,
            updatedAt: this._updatedAt,
        };
    }

    toObject(): IKodyRules {
        return {
            uuid: this._uuid,
            organizationId: this._organizationId,
            rules: this._rules,
            createdAt: this._createdAt,
            updatedAt: this._updatedAt,
        };
    }

    public static create(kodyRules: IKodyRules): KodyRulesEntity {
        return new KodyRulesEntity(kodyRules);
    }

    get uuid(): string {
        return this._uuid;
    }

    get organizationId(): string {
        return this._organizationId;
    }

    get rules(): Partial<IKodyRule>[] {
        return [...this._rules];
    }

    get createdAt(): Date {
        return this._createdAt;
    }

    get updatedAt(): Date {
        return this._updatedAt;
    }
}
