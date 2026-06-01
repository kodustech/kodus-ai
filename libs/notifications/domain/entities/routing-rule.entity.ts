import { Entity } from '@libs/core/domain/interfaces/entity';
import { IRoutingRule } from '../interfaces/routing-rule.interface';

export class RoutingRuleEntity implements Entity<IRoutingRule> {
    private _uuid: string;
    private _organization?: { uuid?: string };
    private _event: string;
    private _category?: string | null;
    private _role: string;
    private _channels: Record<string, boolean>;
    private _createdAt?: Date;
    private _updatedAt?: Date;

    private constructor(data: IRoutingRule | Partial<IRoutingRule>) {
        this._uuid = data.uuid;
        this._organization = data.organization;
        this._event = data.event;
        this._category = data.category;
        this._role = data.role;
        this._channels = data.channels;
        this._createdAt = data.createdAt;
        this._updatedAt = data.updatedAt;
    }

    public static create(
        data: IRoutingRule | Partial<IRoutingRule>,
    ): RoutingRuleEntity {
        return new RoutingRuleEntity(data);
    }

    public get uuid() {
        return this._uuid;
    }
    public get organization() {
        return this._organization;
    }
    public get event() {
        return this._event;
    }
    public get category() {
        return this._category;
    }
    public get role() {
        return this._role;
    }
    public get channels() {
        return this._channels;
    }
    public get createdAt() {
        return this._createdAt;
    }
    public get updatedAt() {
        return this._updatedAt;
    }

    public toObject(): IRoutingRule {
        return {
            uuid: this._uuid,
            organization: this._organization,
            event: this._event,
            category: this._category,
            role: this._role,
            channels: this._channels,
            createdAt: this._createdAt,
            updatedAt: this._updatedAt,
        };
    }

    public toJson(): Partial<IRoutingRule> {
        return this.toObject();
    }
}
