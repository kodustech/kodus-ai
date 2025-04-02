import { METRICS_TYPE } from '../../metrics/enums/metrics.enum';
import { METRICS_CATEGORY } from '../../metrics/enums/metricsCategory.enum';
import { IOrganization } from '../../organization/interfaces/organization.interface';
import { IOrganizationMetrics } from '../interfaces/organizationMetrics.interface';

export class OrganizationMetricsEntity implements IOrganizationMetrics {
    private _uuid: string;
    private _type: METRICS_TYPE;
    private _value: any;
    private _status: boolean;
    private _organization?: Partial<IOrganization>;
    private _createdAt?: string;
    private _referenceDate?: string;
    private _category?: METRICS_CATEGORY;

    constructor(
        organizationMetrics:
            | IOrganizationMetrics
            | Partial<IOrganizationMetrics>,
    ) {
        this._uuid = organizationMetrics.uuid;
        this._type = organizationMetrics.type;
        this._value = organizationMetrics.value;
        this._organization = organizationMetrics.organization;
        this._status = organizationMetrics.status;
        this._createdAt = organizationMetrics.createdAt;
        this._referenceDate = organizationMetrics.referenceDate;
        this._category = organizationMetrics.category;
    }

    public static create(
        organizationMetrics:
            | IOrganizationMetrics
            | Partial<IOrganizationMetrics>,
    ): OrganizationMetricsEntity {
        return new OrganizationMetricsEntity(organizationMetrics);
    }

    public get uuid() {
        return this._uuid;
    }

    public get type() {
        return this._type;
    }

    public get value() {
        return this._value;
    }

    public get status() {
        return this._status;
    }

    public get organization() {
        return this._organization;
    }

    public get createdAt() {
        return this._createdAt;
    }

    public get referenceDate() {
        return this._referenceDate;
    }

    public get category() {
        return this._category;
    }
}
