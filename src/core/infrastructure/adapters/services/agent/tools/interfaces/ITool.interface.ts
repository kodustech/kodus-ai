import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

export const TOOLS_TOKEN = 'DynamicTool';

export type ToolExecutionContext = {
    organizationAndTeamData?: OrganizationAndTeamData;
    [key: string]: any;
};

export interface ITool<Input, Output> {
    name: string;
    description: string;
    definition: object;

    execute(input: Input, context: ToolExecutionContext): Promise<Output>;
}
