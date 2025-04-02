import { GetColumnsConfigTool } from '@/core/infrastructure/adapters/services/agent/tools/implementations/projectManagement/getColumnsConfigTool';
import { TOOLS_TOKEN } from '@/core/infrastructure/adapters/services/agent/tools/interfaces/ITool.interface';
import { TOOL_EXECUTION_SERVICE_TOKEN } from '@/core/infrastructure/adapters/services/agent/tools/interfaces/IToolExecution.interface';
import { ToolExecutionService } from '@/core/infrastructure/adapters/services/agent/tools/toolExecution.service';
import { ProjectManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/projectManagement.service';
import { DynamicModule, Module, forwardRef } from '@nestjs/common';
import { IntegrationModule } from './integration.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { AuthIntegrationModule } from './authIntegration.module';
import { MemoryModule } from './memory.module';
import { TOOL_MANAGER_SERVICE_TOKEN } from '@/core/infrastructure/adapters/services/agent/tools/interfaces/IToolManager.interface';
import { ToolManagerService } from '@/core/infrastructure/adapters/services/agent/tools/toolManager.service';
import { GetWorkItemTypesTool } from '@/core/infrastructure/adapters/services/agent/tools/implementations/projectManagement/getWorkItemTypesTool';
import { GetWorkItemsDeliveryStatusTool } from '@/core/infrastructure/adapters/services/agent/tools/implementations/metrics/getWorkItemsDeliveryStatusTool';
import { MetricsModule } from './metrics.module';
import { MetricsFactory } from '@/core/infrastructure/adapters/services/metrics/processMetrics/metrics.factory';
import { GetWorkItensTool } from '@/core/infrastructure/adapters/services/agent/tools/implementations/projectManagement/getWorkItensTool';
import { GetTeamMetricsTool } from '@/core/infrastructure/adapters/services/agent/tools/implementations/metrics/getTeamMetricsTool';
import { GetDeliveryEstimationForWorkItemsTool } from '@/core/infrastructure/adapters/services/agent/tools/implementations/metrics/getDeliveryEstimationForWorkItemsTool';
import { TeamArtifactsService } from '@/core/infrastructure/adapters/services/teamArtifacts/teamArtifacts.service';
import { GetArtifactsTool } from '@/core/infrastructure/adapters/services/agent/tools/implementations/artifacts/getArtifactsTool';
import { TeamMembersModule } from './teamMembers.module';
import { ParametersModule } from './parameters.module';
import { IntegrationConfigService } from '@/core/infrastructure/adapters/services/integrations/integrationConfig.service';
import { GetEpicsTool } from '@/core/infrastructure/adapters/services/agent/tools/implementations/projectManagement/getEpicsTool';
import { GetPullRequestsTool } from '@/core/infrastructure/adapters/services/agent/tools/implementations/codeManagement/getPullRequestsTool';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { DataAnalysisTool } from '@/core/infrastructure/adapters/services/agent/tools/implementations/commom/dataAnalysisTool';
import { CodeExecutionTool } from '@/core/infrastructure/adapters/services/agent/tools/implementations/commom/codeExecutionTool';
import { S3Module } from './amazonS3.module';
import { S3Service } from '@/core/infrastructure/adapters/services/amazonS3.service';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { ConversationCodeBaseTool } from '@/core/infrastructure/adapters/services/agent/tools/implementations/codeManagement/conversationCodeBaseTool';
import { IntegrationService } from '@/core/infrastructure/adapters/services/integrations/integration.service';
import { WebSearchTool } from '@/core/infrastructure/adapters/services/agent/tools/implementations/commom/webSearchTool';
import { CodeReviewTool } from '@/core/infrastructure/adapters/services/agent/tools/implementations/codeManagement/codeReviewTool';
import { GetSprintTool } from '@/core/infrastructure/adapters/services/agent/tools/implementations/projectManagement/getSprintTool';
import { CodebaseModule } from './codeBase.module';
import { ParametersService } from '@/core/infrastructure/adapters/services/parameters.service';
import { OrganizationParametersModule } from './organizationParameters.module';
import { LLMAnalysisService } from '@/core/infrastructure/adapters/services/codeBase/llmAnalysis.service';
import { KodyRulesModule } from './kodyRules.module';
import { TeamArtifactsModule } from './teamArtifacts.module';
import CodeBaseConfigService from '@/ee/codeBase/codeBaseConfig.service';

@Module({})
export class ToolsModule {
    static forRoot(): DynamicModule {
        return {
            module: ToolsModule,
            imports: [
                forwardRef(() => AuthIntegrationModule),
                forwardRef(() => IntegrationModule),
                forwardRef(() => IntegrationConfigModule),
                forwardRef(() => PlatformIntegrationModule),
                forwardRef(() => MemoryModule),
                forwardRef(() => MetricsModule),
                forwardRef(() => TeamMembersModule),
                forwardRef(() => ParametersModule),
                forwardRef(() => CodebaseModule),
                forwardRef(() => S3Module),
                forwardRef(() => KodyRulesModule),
                OrganizationParametersModule,
                TeamArtifactsModule,
            ],
            providers: [
                GetColumnsConfigTool,
                GetWorkItemTypesTool,
                GetWorkItensTool,
                GetArtifactsTool,
                GetTeamMetricsTool,
                GetDeliveryEstimationForWorkItemsTool,
                GetWorkItemsDeliveryStatusTool,
                ConversationCodeBaseTool,
                ProjectManagementService,
                S3Service,
                MetricsFactory,
                TeamArtifactsService,
                IntegrationConfigService,
                IntegrationService,
                CodeManagementService,
                PinoLoggerService,
                LLMAnalysisService,
                CodeBaseConfigService,
                {
                    provide: TOOLS_TOKEN,
                    useFactory: (
                        projectManagementService: ProjectManagementService,
                        s3Service: S3Service,
                        metricsFactory: MetricsFactory,
                        teamArtifactsService: TeamArtifactsService,
                        integrationConfigService: IntegrationConfigService,
                        codeManagementService: CodeManagementService,
                        pinoLoggerService: PinoLoggerService,
                        lLMAnalysisService: LLMAnalysisService,
                        codeBaseConfigService: CodeBaseConfigService,
                        parametersService: ParametersService,
                    ) => {
                        return [
                            new GetColumnsConfigTool(
                                projectManagementService,
                                pinoLoggerService,
                            ),
                            new GetWorkItemTypesTool(
                                projectManagementService,
                                pinoLoggerService,
                            ),
                            new GetWorkItemsDeliveryStatusTool(
                                metricsFactory,
                                integrationConfigService,
                                projectManagementService,
                                pinoLoggerService,
                            ),
                            new GetWorkItensTool(
                                projectManagementService,
                                pinoLoggerService,
                            ),
                            new GetArtifactsTool(
                                teamArtifactsService,
                                pinoLoggerService,
                            ),
                            new GetTeamMetricsTool(
                                metricsFactory,
                                pinoLoggerService,
                            ),
                            new GetDeliveryEstimationForWorkItemsTool(
                                metricsFactory,
                                projectManagementService,
                                pinoLoggerService,
                            ),
                            new GetEpicsTool(
                                projectManagementService,
                                pinoLoggerService,
                            ),
                            new GetPullRequestsTool(
                                codeManagementService,
                                pinoLoggerService,
                            ),
                            new CodeExecutionTool(pinoLoggerService, s3Service),
                            new DataAnalysisTool(
                                s3Service,
                                pinoLoggerService,
                                projectManagementService,
                            ),
                            new ConversationCodeBaseTool(
                                lLMAnalysisService,
                                pinoLoggerService,
                            ),
                            new WebSearchTool(pinoLoggerService),
                            new CodeReviewTool(
                                codeBaseConfigService,
                                codeManagementService,
                                pinoLoggerService,
                                parametersService,
                            ),
                            new GetSprintTool(
                                projectManagementService,
                                pinoLoggerService,
                            ),
                        ];
                    },
                    inject: [
                        ProjectManagementService,
                        S3Service,
                        MetricsFactory,
                        TeamArtifactsService,
                        IntegrationConfigService,
                        IntegrationService,
                        CodeManagementService,
                        PinoLoggerService,
                        LLMAnalysisService,
                        CodeBaseConfigService,
                    ],
                },
                {
                    provide: TOOL_EXECUTION_SERVICE_TOKEN,
                    useClass: ToolExecutionService,
                },
                {
                    provide: TOOL_MANAGER_SERVICE_TOKEN,
                    useClass: ToolManagerService,
                },
            ],
            exports: [
                TOOLS_TOKEN,
                TOOL_EXECUTION_SERVICE_TOKEN,
                TOOL_MANAGER_SERVICE_TOKEN,
            ],
        };
    }
}
