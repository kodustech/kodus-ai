import { ICheckinHistoryOrganization } from "../interfaces/checkinHistoryOrganization.interface";

export class CheckinHistoryOrganizationEntity implements ICheckinHistoryOrganization {
    private _uuid: string;
    private _date: Date;
    private _teamsIds: string[];
    private _type: string;
    private _organizationId: string;
    private _content: string;
    private _overdueWorkItemsList: Array<string>;

    constructor(checkinHistoryOrganization: ICheckinHistoryOrganization | Partial<ICheckinHistoryOrganization>) {
        this._uuid = checkinHistoryOrganization.uuid;
        this._date = checkinHistoryOrganization.date;
        this._teamsIds = checkinHistoryOrganization.teamsIds;
        this._type = checkinHistoryOrganization.type;
        this._organizationId = checkinHistoryOrganization.organizationId;
        this._content = checkinHistoryOrganization.content;
        this._overdueWorkItemsList = checkinHistoryOrganization.overdueWorkItemsList;
    }


    public static create(
        teamArtifacts: ICheckinHistoryOrganization | Partial<ICheckinHistoryOrganization>,
    ): CheckinHistoryOrganizationEntity {
        return new CheckinHistoryOrganizationEntity(teamArtifacts);
    }

    get uuid(): string {
        return this._uuid;
    }

    get date(): Date {
        return this._date;
    }

    get teamsIds(): string[] {
        return this._teamsIds;
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

    get overdueWorkItemsList(): Array<string> {
        return this._overdueWorkItemsList;
    }
}
