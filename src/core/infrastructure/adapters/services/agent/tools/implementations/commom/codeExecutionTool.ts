import { Injectable } from '@nestjs/common';
import { ITool, ToolExecutionContext } from '../../interfaces/ITool.interface';
import { IToolResult } from '@/core/domain/agents/interfaces/toolResult.interface';
import {
    getOpenAIAssistant,
    getOpenAIAssistantFileContent,
} from '@/shared/utils/langchainCommon/document';
import { PinoLoggerService } from '../../../../logger/pino.service';
import {
    createTempFileFromData,
    createThreadAndRun,
    getResponseRunThread,
    openAIDeleteFile,
    openAIRetrieveFile,
    openAIUploadFile,
} from '@/shared/utils';
import { ARTIFACTS_STRUCTURE_DATA } from '../../../structureData/artifacts';
import { METRICS_STRUCTURE_DATA } from '../../../structureData/metrics';
import { WORKITEM_STRUCTURE_DATA } from '../../../structureData/workItems';
import { PULL_REQUEST_STRUCTURE_DATA } from '../../../structureData/pullRequest';
import { fileTypeFromBuffer } from 'file-type';
import { S3Service } from '../../../../amazonS3.service';

const codeExecutionToolDefinition = {
    tool_name: 'CodeExecutionTool',
    tool_description:
        'Executes code snippets or instructions provided by the user in various programming languages. This includes performing calculations, running complex algorithms, debugging code, and testing programming concepts.',
    tool_signals_to_choose:
        'Use this tool for any task that requires running code to perform calculations, algorithm testing, generate some type of file or debugging. It is particularly useful for tasks that involve computational logic or solving mathematical problems.',
    tool_parameters: {
        parameter_instructions: {
            parameter_instructions_example:
                '{"language": "python", "instructions": "Write a function to calculate the factorial of a number.", "code": "def factorial(n): return 1 if n == 0 else n * factorial(n-1)"}',
            parameter_instructions_required: true,
            parameter_instructions_description:
                'An object containing the programming language, detailed instructions, and optionally the code snippet to be executed. The language should be specified as a string, instructions as a string, and code as a string containing the code to be executed.',
        },
    },
    tool_data_return_structure: {
        executionResult: {
            output: 'string',
            errors: 'string',
            logs: 'string[]',
        },
    },
};

@Injectable()
export class CodeExecutionTool implements ITool<any, IToolResult> {
    constructor(
        private logger: PinoLoggerService,
        private readonly s3Service: S3Service,
    ) {}

    get name(): string {
        return CodeExecutionTool.name;
    }

    get description(): string {
        return 'Executes code snippets or instructions provided by the user in various programming languages. This includes performing calculations, running complex algorithms, debugging code, and testing programming concepts. Return this structure: {"executionResult": {"output": "string", "errors": "string", "logs": ["string"]}}';
    }

    get definition(): object {
        return codeExecutionToolDefinition;
    }

    async execute(
        input: any,
        context: ToolExecutionContext,
    ): Promise<IToolResult> {
        try {
            const instructions = input?.parameters?.parameter_instructions;

            const artifacts = input?.parameters?.GetArtifactsTool?.artifacts;
            const metrics = input?.parameters?.GetTeamMetricsTool?.metrics;
            const workItems = input?.parameters?.GetWorkItensTool?.weekTasks;
            const pullRequests =
                input?.parameters?.GetPullRequestsTool?.pullRequests;

            if (
                !instructions &&
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

            const content = this.formatData(instructions, structureData);

            const run = await createThreadAndRun(
                'asst_Pk70o3uDVfXhTMtNJbwK3qs6',
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
                message: 'Error executing Code Execution Tool',
                context: CodeExecutionTool.name,
                error: error,
                metadata: {
                    teamId: context.organizationAndTeamData.teamId,
                    organizationId:
                        context.organizationAndTeamData.organizationId,
                },
            });
            return {
                stringResult:
                    'Error executing Code Execution Tool. Please try again.',
                jsonResult: [],
            };
        }
    }

    private formatData(instructions, structureData) {
        let structureDataResult = '';

        structureData.forEach((item) => {
            structureDataResult += `
                {
                    file:id: ${item?.file?.id},
                    glossary: ${JSON.stringify(item.glossary)},
                }`;
        });

        return `
User Instructions: ${instructions}

System instructions:
- Data will be in input or in files in JSONL format, consider both;
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
            .map((url) => `- [File](${url})`)
            .join('\n');
        return `###Data Analyst Tool Response  \n\n${textContent}\n\n### Files\n${urls}`;
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
