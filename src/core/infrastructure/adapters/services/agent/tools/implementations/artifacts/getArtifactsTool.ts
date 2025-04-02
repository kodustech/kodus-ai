import { IToolResult } from '@/core/domain/agents/interfaces/toolResult.interface';
import { ITool, ToolExecutionContext } from '../../interfaces/ITool.interface';
import { Inject, Injectable } from '@nestjs/common';
import {
    ITeamArtifactsService,
    TEAM_ARTIFACTS_SERVICE_TOKEN,
} from '@/core/domain/teamArtifacts/contracts/teamArtifacts.service.contracts';
import { PinoLoggerService } from '../../../../logger/pino.service';

const toolDefinition = {
    tool_name: 'GetArtifactsTool',
    tool_description:
        'This tool meticulously identifies challenges and achievements in team activities, providing actionable insights into productivity, efficiency, and areas for improvement. Its designed for in-depth diagnostics of team dynamics and pinpointing operational patterns, offering a qualitative analysis beyond standard metrics.',
    tool_signals_to_choose:
        'When productivity issues, workflow inefficiencies, or specific performance concerns necessitate a detailed investigation. Particularly useful for comprehensive qualitative analyses that delve deeper than standard metrics, uncovering underlying issues and highlighting achievements. Useful to deep investigation about problems',
    tool_parameters: {
        parameter_frequenceType: {
            parameter_frequenceType_example: 'daily',
            parameter_frequenceType_enum: "['daily', 'weekly', 'all']",
            parameter_frequenceType_required: false,
            parameter_frequenceType_description:
                "Specifies the artifact frequency type, selecting from 'daily' for artifacts generated each day, 'weekly' for a weekly aggregation, or 'all' for every artifact irrespective of frequency.",
        },
    },
    tool_data_return_structure: {
        mostRecentArtifacts: {
            date: 'string (YYYY-MM-DD)',
            artifacts: [
                {
                    name: 'string',
                    description: 'string',
                    category: 'string',
                    resultType: 'string',
                    howIsIdentified: 'string',
                    whyIsImportant: 'string',
                    impactArea: 'string',
                    analysisFinalDate: 'string (ISO 8601)',
                    frequenceType: 'string',
                    additionalData: [
                        {
                            score: 'number',
                            obs: 'string',
                            workItemId: 'number',
                            workItemKey: 'string',
                        },
                    ],
                    relatedData: {
                        metrics:
                            'metrics that this alert/artifact is related. array.',
                        artifacts:
                            'alerts/artifacts that this alert/artifact is related. array.',
                    },
                },
            ],
        },
        previousArtifacts: [
            {
                name: 'string',
                description: 'string',
                category: 'string',
                resultType: 'string',
                howIsIdentified: 'string',
                whyIsImportant: 'string',
                impactArea: 'string',
                analysisFinalDate: 'string (ISO 8601)',
                frequenceType: 'string',
                additionalData: [
                    {
                        score: 'number',
                        obs: 'string',
                        workItemId: 'number',
                        workItemKey: 'string',
                    },
                ],
            },
        ],
    },
};
@Injectable()
export class GetArtifactsTool implements ITool<any, IToolResult> {
    constructor(
        @Inject(TEAM_ARTIFACTS_SERVICE_TOKEN)
        private readonly teamArtifactsService: ITeamArtifactsService,
        private logger: PinoLoggerService,
    ) {}

    get name(): string {
        return GetArtifactsTool.name;
    }

    get description(): string {
        return 'Get all artifacts (e.g., screenshots, videos, etc.)';
    }

    get definition(): object {
        return toolDefinition;
    }

    async execute(
        input: any,
        context: ToolExecutionContext,
    ): Promise<IToolResult> {
        try {
            const frequenceType = input?.parameters?.parameter_frequenceType;

            const artifacts =
                await this.teamArtifactsService.getRecentTeamArtifactsWithPrevious(
                    context.organizationAndTeamData,
                    3,
                    this.formatFrequenceType(frequenceType),
                );

            return {
                stringResult: this.formatReturnToPrompt(artifacts),
                jsonResult: {
                    artifacts,
                },
            };
        } catch (error) {
            this.logger.error({
                message: 'Error executing Get Artifacts Tool',
                context: GetArtifactsTool.name,
                error: error,
                metadata: {
                    teamId: context.organizationAndTeamData.teamId,
                    organizationId:
                        context.organizationAndTeamData.organizationId,
                },
            });
            return {
                stringResult:
                    'Error executing Get Team Artifacts Tool. Please try again.',
                jsonResult: [],
            };
        }
    }

    private formatFrequenceType(frequence: string) {
        if (!frequence) {
            return null;
        }

        if (!frequence || frequence === 'all') {
            return null;
        }

        return frequence;
    }

    private formatReturnToPrompt(artifacts: any): string {
        if (!artifacts || artifacts?.length <= 0) {
            return 'Unable to find information for this item';
        }

        const artifactsStructureExplaned = {
            name: 'Artifact Name',
            description: 'Artifact Description',
            category: 'Category Artifact',
            resultType: 'Result Type Artifact (Positive, Negative)',
            howIsIdentified: 'Explanation of how artifact was identified.',
            whyIsImportant: 'Explanation to why is important',
            impactArea:
                'Explain which area is impacted ("Delivery speed", "Delivery quality", "Flow quality", etc...)',
            analysisFinalDate: 'string (ISO 8601)',
            frequenceType: '["weekly", "daily"]',
            additionalData: 'may contain items analyzed by artifacts',
        };

        return `Explanation of the structure of an artifact (Remember to consider): ${JSON.stringify(artifactsStructureExplaned)} \n\n Artifacts are summaries of what happened to the team in recent weeks. Last Artifacts: \n\n ${JSON.stringify(artifacts)}`;
    }
}
