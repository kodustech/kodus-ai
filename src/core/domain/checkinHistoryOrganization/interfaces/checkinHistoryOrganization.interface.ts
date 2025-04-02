export interface ICheckinHistoryOrganization {
    uuid: string;
    date: Date;
    teamsIds: string[];
    type: string;
    organizationId: string;
    content: string;
    overdueWorkItemsList?: Array<string>;
}
