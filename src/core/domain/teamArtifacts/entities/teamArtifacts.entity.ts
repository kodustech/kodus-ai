import { Entity } from '@/shared/domain/interfaces/entity';
import { IImpactDataRelationship, IRelatedData, ITeamArtifacts } from '../interfaces/teamArtifacts.interface';

export class TeamArtifactsEntity implements Entity<ITeamArtifacts> {
    private _uuid: string;
    private _title: string;
    private _name: string;
    private _analysisInitialDate: Date;
    private _analysisFinalDate: Date;
    private _category: string;
    private _description: string;
    private _relatedItems: string;
    private _criticality: string;
    private _resultType: string;
    private _impactArea: string;
    private _howIsIdentified: string;
    private _whyIsImportant: string;
    private _teamId: string;
    private _organizationId: string;
    private _frequenceType: string;
    private _teamMethodology: string;
    private _additionalData: any;
    private _additionalInfoFormated: string;
    private _impactLevel: number;
    private _impactDataRelationship?: IImpactDataRelationship;
    private _relatedData?: IRelatedData;

    constructor(teamArtifacts: ITeamArtifacts | Partial<ITeamArtifacts>) {
        this._uuid = teamArtifacts.uuid;
        this._title = teamArtifacts.title;
        this._name = teamArtifacts.name;
        this._analysisInitialDate = teamArtifacts.analysisInitialDate;
        this._analysisFinalDate = teamArtifacts.analysisFinalDate;
        this._category = teamArtifacts.category;
        this._description = teamArtifacts.description;
        this._relatedItems = teamArtifacts.relatedItems;
        this._criticality = teamArtifacts.criticality;
        this._resultType = teamArtifacts.resultType;
        this._impactArea = teamArtifacts.impactArea;
        this._howIsIdentified = teamArtifacts.howIsIdentified;
        this._whyIsImportant = teamArtifacts.whyIsImportant;
        this._teamId = teamArtifacts.teamId;
        this._organizationId = teamArtifacts.organizationId;
        this._frequenceType = teamArtifacts.frequenceType;
        this._teamMethodology = teamArtifacts.teamMethodology;
        this._additionalData = teamArtifacts.additionalData;
        this._additionalInfoFormated = teamArtifacts.additionalInfoFormated;
        this._impactLevel = teamArtifacts.impactLevel;
        this._impactDataRelationship = teamArtifacts.impactDataRelationship;
        this._relatedData = teamArtifacts.relatedData;
    }

    toObject(): ITeamArtifacts {
        return {
            uuid: this._uuid,
            title: this._title,
            name: this._name,
            analysisInitialDate: this._analysisInitialDate,
            analysisFinalDate: this._analysisFinalDate,
            category: this._category,
            description: this._description,
            relatedItems: this._relatedItems,
            criticality: this._criticality,
            resultType: this._resultType,
            impactArea: this._impactArea,
            howIsIdentified: this._howIsIdentified,
            whyIsImportant: this._whyIsImportant,
            teamId: this._teamId,
            organizationId: this._organizationId,
            frequenceType: this._frequenceType,
            teamMethodology: this._teamMethodology,
            additionalData: this._additionalData,
            additionalInfoFormated: this._additionalInfoFormated,
            impactLevel: this._impactLevel,
            impactDataRelationship: this._impactDataRelationship,
            relatedData: this._relatedData,
        };
    }
    toJson(): ITeamArtifacts | Partial<ITeamArtifacts> {
        return {
            uuid: this._uuid,
            title: this._title,
            name: this._name,
            analysisInitialDate: this._analysisInitialDate,
            analysisFinalDate: this._analysisFinalDate,
            category: this._category,
            description: this._description,
            relatedItems: this._relatedItems,
            criticality: this._criticality,
            resultType: this._resultType,
            impactArea: this._impactArea,
            howIsIdentified: this._howIsIdentified,
            whyIsImportant: this._whyIsImportant,
            teamId: this._teamId,
            organizationId: this._organizationId,
            frequenceType: this._frequenceType,
            teamMethodology: this._teamMethodology,
            additionalData: this._additionalData,
            additionalInfoFormated: this._additionalInfoFormated,
            impactLevel: this._impactLevel,
            impactDataRelationship: this._impactDataRelationship,
            relatedData: this._relatedData,
        };
    }

    public static create(
        teamArtifacts: ITeamArtifacts | Partial<ITeamArtifacts>,
    ): TeamArtifactsEntity {
        return new TeamArtifactsEntity(teamArtifacts);
    }

    get uuid(): string {
        return this._uuid;
    }

    get title(): string {
        return this._title;
    }

    get name(): string {
        return this._name;
    }

    get analysisInitialDate(): Date {
        return this._analysisInitialDate;
    }

    get analysisFinalDate(): Date {
        return this._analysisFinalDate;
    }

    get category(): string {
        return this._category;
    }

    get description(): string {
        return this._description;
    }

    get relatedItems(): string {
        return this._relatedItems;
    }

    get criticality(): string {
        return this._criticality;
    }

    get resultType(): string {
        return this._resultType;
    }

    get impactArea(): string {
        return this._impactArea;
    }

    get howIsIdentified(): string {
        return this._howIsIdentified;
    }

    get whyIsImportant(): string {
        return this._whyIsImportant;
    }

    get teamId(): string {
        return this._teamId;
    }

    get organizationId(): string {
        return this._organizationId;
    }

    get frequenceType(): string {
        return this._frequenceType;
    }

    get teamMethodology(): string {
        return this._teamMethodology;
    }

    get additionalData(): any {
        return this._additionalData;
    }

    get impactDataRelationship(): IImpactDataRelationship {
        return this._impactDataRelationship;
    }

    get relatedData(): IRelatedData {
        return this._relatedData;
    }

    public get additionalInfoFormated(): string {
        return this._additionalInfoFormated;
    }

    public get impactLevel(): number {
        return this._impactLevel;
    }
}
