export interface ICheckinHistory {
    uuid: string;
    date: Date;
    teamId: string;
    type: string;
    organizationId: string;
    content: string;
    sectionDataItems?: any;
    overdueWorkItemsList?: Array<string>;
}
