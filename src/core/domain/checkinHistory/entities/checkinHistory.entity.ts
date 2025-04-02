import { ICheckinHistory } from '../interfaces/checkinHistory.interface';

export class CheckinHistoryEntity implements ICheckinHistory {
    private _uuid: string;
    private _date: Date;
    private _teamId: string;
    private _type: string;
    private _organizationId: string;
    private _content: string;
    private _sectionDataItems: any;
    private _overdueWorkItemsList: Array<string>;

    constructor(checkinHistory: ICheckinHistory | Partial<ICheckinHistory>) {
        this._uuid = checkinHistory.uuid;
        this._date = checkinHistory.date;
        this._teamId = checkinHistory.teamId;
        this._type = checkinHistory.type;
        this._organizationId = checkinHistory.organizationId;
        this._content = checkinHistory.content;
        this._sectionDataItems = checkinHistory.sectionDataItems;
        this._overdueWorkItemsList = checkinHistory.overdueWorkItemsList;
    }

    public static create(
        teamArtifacts: ICheckinHistory | Partial<ICheckinHistory>,
    ): CheckinHistoryEntity {
        return new CheckinHistoryEntity(teamArtifacts);
    }

    get uuid(): string {
        return this._uuid;
    }

    get date(): Date {
        return this._date;
    }

    get teamId(): string {
        return this._teamId;
    }

    get type(): string {
        return this._type;
    }

    get organizationId(): string {
        return this._organizationId;
    }

    get content(): string {
        return this._content;
    }

    get sectionDataItems(): any {
        return this._sectionDataItems;
    }

    get overdueWorkItemsList(): Array<string> {
        return this._overdueWorkItemsList;
    }
}
