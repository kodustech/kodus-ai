import { ITeam } from '../../team/interfaces/team.interface';
import { METRICS_TYPE } from '../enums/metrics.enum';
import { METRICS_CATEGORY } from '../enums/metricsCategory.enum';
import { IMetrics } from '../interfaces/metrics.interface';

export class MetricsEntity implements IMetrics {
    private _uuid: string;
    private _type: METRICS_TYPE;
    private _value: any;
    private _status: boolean;
    private _team?: Partial<ITeam>;
    private _createdAt?: string;
    private _category?: METRICS_CATEGORY;
    private _referenceDate?: string;

    constructor(metrics: IMetrics | Partial<IMetrics>) {
        this._uuid = metrics.uuid;
        this._type = metrics.type;
        this._value = metrics.value;
        this._team = metrics.team;
        this._status = metrics.status;
        this._createdAt = metrics.createdAt;
        this._category = metrics.category;
        this._referenceDate = metrics.referenceDate;
    }

    public static create(metrics: IMetrics | Partial<IMetrics>): MetricsEntity {
        return new MetricsEntity(metrics);
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

    public get team() {
        return this._team;
    }

    public get createdAt() {
        return this._createdAt;
    }

    public get category() {
        return this._category;
    }

    public get referenceDate() {
        return this._referenceDate;
    }
}
