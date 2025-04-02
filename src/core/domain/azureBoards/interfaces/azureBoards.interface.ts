import { ColumnsConfigKey } from '../../integrationConfigs/types/projectManagement/columns.type';

export interface IAzureBoards {
    uuid?: string;
    organizationId?: string;
    columns: ColumnsConfigKey[];
    boardId?: string;
}
