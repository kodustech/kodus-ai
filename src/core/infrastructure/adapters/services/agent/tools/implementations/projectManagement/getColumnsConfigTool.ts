import { Injectable } from '@nestjs/common';
import { ITool, ToolExecutionContext } from '../../interfaces/ITool.interface';
import { ProjectManagementService } from '../../../../platformIntegration/projectManagement.service';
import {
    ColumnsConfigKey,
    ColumnsConfigResult,
} from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import { ZodObject, z } from 'zod';
import { IToolResult } from '@/core/domain/agents/interfaces/toolResult.interface';
import { PinoLoggerService } from '../../../../logger/pino.service';

const getColumnsConfigSchema = z.object({
    boardId: z
        .string()
        .optional()
        .describe(
            'The ID of the board for which to retrieve the column configuration.',
        ),
});

const toolDefinition = {
    tool_name: 'GetColumnsConfigTool',
    tool_description:
        "Retrieves the configurations of a board's columns, including ID, Name, and Order, and categorizes columns into WIP, done, and to-do. Essential for understanding the board's organization.",
    tool_signals_to_choose:
        "Use when information about the configuration and organization of a board's columns is required.",
    tool_data_return_structure: {
        wipColumnsAndDoneColumns: ['string'],
        columnsConfig: {
            allColumns: [
                {
                    id: 'string',
                    name: 'string',
                    order: 'number|null',
                    column: 'string',
                },
            ],
            wipColumns: ['string'],
            doneColumns: ['string'],
            todoColumns: ['string'],
        },
    },
    tool_parameters: {},
};

@Injectable()
export class GetColumnsConfigTool implements ITool<any, IToolResult> {
    constructor(
        private readonly projectManagementService: ProjectManagementService,
        private logger: PinoLoggerService,
    ) {}

    get name(): string {
        return GetColumnsConfigTool.name;
    }

    get description(): string {
        return 'Retrieves the ID and Name of the columns (To Do, WIP, and Done) of a board, along with their respective order. Useful for understanding the board configuration. Return this structure: "{"wipColumnsAndDoneColumns":["string"],"columnsConfig":{"allColumns":[{"id":"string","name":"string","order":"number|null","column":"string"}],"wipColumns":["string"],"doneColumns":["string"],"todoColumns":["string"]}}"';
    }

    get dependencies(): string[] {
        return [];
    }

    get schema(): ZodObject<any> {
        return getColumnsConfigSchema;
    }

    get definition(): object {
        return toolDefinition;
    }

    async execute(
        input: any,
        context: ToolExecutionContext,
    ): Promise<IToolResult> {
        try {
            const columnsConfig: ColumnsConfigResult =
                await this.projectManagementService.getColumnsConfig(
                    context.organizationAndTeamData,
                );

            const wipColumnsAndDoneColumns = columnsConfig?.allColumns
                .filter(
                    (columnConfig: ColumnsConfigKey) =>
                        columnConfig.column === 'wip' ||
                        columnConfig.column === 'done',
                )
                .map((columnConfig) => columnConfig.id);

            return {
                stringResult: this.formatReturnToPrompt(columnsConfig),
                jsonResult: {
                    columnsConfig,
                    wipColumnsAndDoneColumns,
                },
            };
        } catch (error) {
            this.logger.error({
                message: 'Error executing Get Columns Config Tool',
                context: GetColumnsConfigTool.name,
                error: error,
                metadata: {
                    teamId: context.organizationAndTeamData.teamId,
                    organizationId:
                        context.organizationAndTeamData.organizationId,
                },
            });
            return {
                stringResult:
                    'Error executing Get Columns Config Tool. Please try again.',
                jsonResult: [],
            };
        }
    }

    private formatReturnToPrompt(columnsConfig: ColumnsConfigResult): string {
        if (!columnsConfig) {
            return 'Board Configuration not found';
        }

        return `Board Configuration For This Team:
        To Do Columns: ${JSON.stringify(columnsConfig.allColumns.filter((column) => column.column === 'todo'))}
        WIP (Work In Progress Columns): ${JSON.stringify(columnsConfig.allColumns.filter((column) => column.column === 'wip'))}
        Done Columns: ${JSON.stringify(columnsConfig.allColumns.filter((column) => column.column === 'done'))}
        `;
    }

    private getDependenciesParams(input: any): any {
        let combinedParams = {};

        this.dependencies.forEach((dependency) => {
            if (input[dependency]) {
                combinedParams = { ...combinedParams, ...input[dependency] };
            }
        });

        return combinedParams;
    }
}
