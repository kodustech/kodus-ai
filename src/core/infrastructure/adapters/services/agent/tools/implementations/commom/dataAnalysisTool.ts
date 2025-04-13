import { Injectable } from '@nestjs/common';
import { ITool, ToolExecutionContext } from '../../interfaces/ITool.interface';
import { IToolResult } from '@/core/domain/agents/interfaces/toolResult.interface';
import { fileTypeFromBuffer } from 'file-type';
import {
    getOpenAIAssistant,
    getOpenAIAssistantFileContent,
} from '@/shared/utils/langchainCommon/document';
import { S3Service } from '../../../../amazonS3.service';
import {
    createTempFileFromData,
    createThreadAndRun,
    getResponseRunThread,
    openAIDeleteFile,
    openAIRetrieveFile,
    openAIUploadFile,
} from '@/shared/utils';
import { WORKITEM_STRUCTURE_DATA } from '../../../structureData/workItems';
import { METRICS_STRUCTURE_DATA } from '../../../structureData/metrics';
import { ARTIFACTS_STRUCTURE_DATA } from '../../../structureData/artifacts';
import { PULL_REQUEST_STRUCTURE_DATA } from '../../../structureData/pullRequest';
import { PinoLoggerService } from '../../../../logger/pino.service';
import { ColumnsConfigResult } from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import { ProjectManagementService } from '../../../../platformIntegration/projectManagement.service';

const dataAnalysisToolDefinition = {
    tool_name: 'DataAnalysisTool',
    tool_description:
        'Analyzes and processes data retrieved from various sources. This includes performing data manipulation, computing metrics, analyzing trends, and providing insights based on the data.',
    tool_signals_to_choose:
        'Use this tool for any task that requires analyzing or manipulating data obtained from other tools. It is especially useful for tasks that involve data analysis, computing metrics, ou generating insights from data.',
    tool_parameters: {
        parameter_data: {
            parameter_data_example:
                '{"data": [{"id": "1", "title": "PR1", "created_at": "2023-01-01"}]',
            parameter_data_required: true,
            parameter_data_description:
                'An object containing the data source, the data itself. The source should be specified as a string, data as an array of objects.',
        },
        parameter_instructions: {
            parameter_data_example: 'Conduct a deep analysis into this data.',
            parameter_instructions_required: true,
            parameter_instructions_description:
                'Instructions as a string detailing the analysis to be performed.',
        },
    },
    tool_data_return_structure: {
        analysisResult: {
            output: 'string',
            errors: 'string',
            logs: 'string[]',
        },
    },
};

@Injectable()
export class DataAnalysisTool implements ITool<any, IToolResult> {
    constructor(
        private readonly s3Service: S3Service,
        private logger: PinoLoggerService,
        private readonly projectManagementService: ProjectManagementService,
    ) {}

    get name(): string {
        return DataAnalysisTool.name;
    }

    get description(): string {
        return 'Analyzes and processes data retrieved from various sources. This includes performing data manipulation, computing metrics, analyzing trends, and providing insights based on the data. Return this structure: {"analysisResult": {"output": "string", "errors": "string", "logs": ["string"]}}';
    }

    get definition(): object {
        return dataAnalysisToolDefinition;
    }

    async execute(
        input: any,
        context: ToolExecutionContext,
    ): Promise<IToolResult> {
        try {
            const data = input?.parameters?.parameter_data;
            const instructions = input?.parameters?.parameter_instructions;

            const artifacts = input?.parameters?.GetArtifactsTool?.artifacts;
            const metrics = input?.parameters?.GetTeamMetricsTool?.metrics;
            const workItems = input?.parameters?.GetWorkItensTool?.weekTasks;
            const pullRequests =
                input?.parameters?.GetPullRequestsTool?.pullRequests;

            if (
                !data &&
                !artifacts &&
                !metrics &&
                !workItems &&
                !pullRequests
            ) {
                return {
                    stringResult: '',
                    jsonResult: {},
                };
            }

            const fileIds = [];
            const structureData = [];

            await this.processData(
                artifacts,
                'artifacts',
                ARTIFACTS_STRUCTURE_DATA.artifacts_glossary,
                fileIds,
                structureData,
            );
            await this.processData(
                metrics,
                'metrics',
                METRICS_STRUCTURE_DATA.metrics_glossary,
                fileIds,
                structureData,
            );
            await this.processData(
                workItems,
                'workItems',
                WORKITEM_STRUCTURE_DATA.work_item_glossary,
                fileIds,
                structureData,
            );
            await this.processData(
                pullRequests,
                'pullRequests',
                PULL_REQUEST_STRUCTURE_DATA.pull_request_glossary,
                fileIds,
                structureData,
            );

            const columnsConfig: ColumnsConfigResult =
                await this.projectManagementService.getColumnsConfig(
                    context.organizationAndTeamData,
                );

            const content = this.formatData(
                instructions,
                structureData,
                columnsConfig,
                data,
            );

            const run = await createThreadAndRun(
                'asst_qHDtbGbwpX22NPUJrFpmxS4V',
                content,
                fileIds,
            );

            const result = await getResponseRunThread(run.id, run.thread_id);

            await this.deleteFileIds(fileIds);

            const responseFormatted = await this.processResponse(
                result,
                context.organizationAndTeamData.organizationId,
                context.organizationAndTeamData.teamId,
            );

            return {
                stringResult: responseFormatted,
                jsonResult: responseFormatted,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error executing Data Analysis Tool',
                context: DataAnalysisTool.name,
                error: error,
                metadata: {
                    teamId: context.organizationAndTeamData.teamId,
                    organizationId:
                        context.organizationAndTeamData.organizationId,
                },
            });
            return {
                stringResult:
                    'Error executing Data Analyst Tool. Please try again.',
                jsonResult: [],
            };
        }
    }

    private formatData(instructions, structureData, columnsConfig, data) {
        let structureDataResult = '';

        structureData.forEach((item) => {
            structureDataResult += `
                {
                    file:id: ${item.file.id},
                    glossary: ${JSON.stringify(item.glossary)},
                }`;
        });

        return `
User Instructions: ${instructions}

Input data: ${JSON.stringify(data)}

Board Configuration For This Team:
To Do Columns: ${JSON.stringify(columnsConfig.allColumns.filter((column) => column.column === 'todo'))}\n
WIP (Work In Progress Columns): ${JSON.stringify(columnsConfig.allColumns.filter((column) => column.column === 'wip'))}\n
Done Columns: ${JSON.stringify(columnsConfig.allColumns.filter((column) => column.column === 'done'))}\n

System instructions:
- Process data from files or/and input data;
- Be analytical with the instruction given by the user.
- Consider that the file was created in JSONL format.
- The file may contain properties/variables with empty values.
- The file may not contain all properties/variables.
- The file may have objects that do not have all properties/variables.
- Consider that the object properties may follow the "camelCase, snake-case, etc..." pattern.
- Load and analyze the file using pandas and best practices.
- Remember to check for nulls, exceptions, and other code quality practices.

Structure files instructions: "Use the data glossary below to understand the structure and meaning of the provided JSONL data: { file:id: "file identifier", glossary: "glossary of the file in question"}."
${structureDataResult}
`;
    }

    async generateResponseForUser(textContents, uploadedFilesUrls) {
        const textContent = textContents.join('\n\n');
        const urls = uploadedFilesUrls
            .map((url) => `- File: ${url}`)
            .join('\n');
        return `###Data Analyst Tool Response  \n\n${textContent}\n\n ### Files Response (can be images, charts, sheets, etc...)\n ${urls}`;
    }

    async processResponse(response, organizationId, teamId) {
        const messages = response;
        const filesToDownload = [];
        const textContents = [];

        messages.forEach((message) => {
            message.content.forEach((content) => {
                if (content.type === 'image_file') {
                    filesToDownload.push(content.image_file.file_id);
                } else if (content.type === 'text') {
                    textContents.push(content.text.value);
                }
            });
        });

        let uploadedFilesUrls = [];
        if (filesToDownload.length > 0) {
            uploadedFilesUrls = await this.downloadAndUploadFiles(
                filesToDownload,
                organizationId,
                teamId,
            );
        }

        return this.generateResponseForUser(textContents, uploadedFilesUrls);
    }

    private async processData(
        data,
        dataType,
        glossary,
        fileIds,
        structureData,
    ) {
        if (data && (Array.isArray(data) || typeof data === 'object')) {
            const tempFile = await createTempFileFromData(data, dataType);
            const resultFile = await openAIUploadFile(tempFile);

            fileIds.push(resultFile?.id);

            structureData.push({
                file: { id: resultFile?.id },
                glossary: glossary,
            });
        }
    }

    private async downloadAndUploadFiles(
        fileIds,
        organizationId: string,
        teamId: string,
    ) {
        const uploadedFilesUrls = [];
        const bucketName = await this.s3Service.createUniqueBucket();

        for (const fileId of fileIds) {
            const fileResponse = await openAIRetrieveFile(fileId);
            const fileContent = await getOpenAIAssistantFileContent(fileId);

            const fileType = await fileTypeFromBuffer(fileContent);
            const extension = fileType ? `.${fileType.ext}` : '.png';

            const fileName = `${organizationId}/${teamId}/${fileResponse.filename}${extension}`;

            await this.s3Service.uploadFile(
                bucketName,
                fileContent,
                fileName,
                fileType?.mime || 'application/octet-stream',
            );

            uploadedFilesUrls.push(
                `https://${bucketName}.s3.${process.env.API_AWS_REGION}.amazonaws.com/${fileName}`,
            );
        }

        return uploadedFilesUrls;
    }

    private async deleteFileIds(fileIds: any) {
        try {
            await fileIds.forEach(async (file) => {
                await openAIDeleteFile(file);
            });
        } catch (error) {
            console.log(error);
        }
    }
}
