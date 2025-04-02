import { IOrganizationArtifacts } from '../interfaces/organizationArtifacts.interface';
import { OrganizationTeamArtifact } from '../types/organizationTeamArtifact.type';

export class OrganizationArtifactsEntity implements IOrganizationArtifacts {
    private _uuid: string;
    private _name: string;
    private _description: string;
    private _analysisInitialDate: Date;
    private _analysisFinalDate: Date;
    private _relatedItems: string;
    private _resultType: string;
    private _category: string;
    private _impactArea: string;
    private _howIsIdentified: string;
    private _whyIsImportant: string;
    private _teamsArtifact: OrganizationTeamArtifact[];
    private _organizationId: string;
    private _frequenceType: string;

    constructor(
        organizationArtifacts:
            | IOrganizationArtifacts
            | Partial<IOrganizationArtifacts>,
    ) {
        this._uuid = organizationArtifacts.uuid;
        this._name = organizationArtifacts.name;
        this._description = organizationArtifacts.description;
        this._analysisInitialDate = organizationArtifacts.analysisInitialDate;
        this._analysisFinalDate = organizationArtifacts.analysisFinalDate;
        this._relatedItems = organizationArtifacts.relatedItems;
        this._resultType = organizationArtifacts.resultType;
        this._category = organizationArtifacts.category;
        this._impactArea = organizationArtifacts.impactArea;
        this._howIsIdentified = organizationArtifacts.howIsIdentified;
        this._whyIsImportant = organizationArtifacts.whyIsImportant;
        this._teamsArtifact = organizationArtifacts.teamsArtifact;
        this._organizationId = organizationArtifacts.organizationId;
        this._frequenceType = organizationArtifacts.frequenceType;
    }

    public static create(
        organizationArtifact:
            | IOrganizationArtifacts
            | Partial<IOrganizationArtifacts>,
    ): OrganizationArtifactsEntity {
        return new OrganizationArtifactsEntity(organizationArtifact);
    }

    public get uuid(): string {
        return this._uuid;
    }

    public get name(): string {
        return this._name;
    }

    public get description(): string {
        return this._description;
    }

    public get analysisInitialDate(): Date {
        return this._analysisInitialDate;
    }

    public get analysisFinalDate(): Date {
        return this._analysisFinalDate;
    }

    public get relatedItems(): string {
        return this._relatedItems;
    }

    public get resultType(): string {
        return this._resultType;
    }

    public get category(): string {
        return this._category;
    }

    public get impactArea(): string {
        return this._impactArea;
    }

    public get howIsIdentified(): string {
        return this._howIsIdentified;
    }

    public get whyIsImportant(): string {
        return this._whyIsImportant;
    }

    public get teamsArtifact(): OrganizationTeamArtifact[] {
        return this._teamsArtifact;
    }

    public get organizationId(): string {
        return this._organizationId;
    }

    public get frequenceType(): string {
        return this._frequenceType;
    }
}
