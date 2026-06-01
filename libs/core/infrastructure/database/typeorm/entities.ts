import { ContextReferenceModel } from '../../../../ai-engine/infrastructure/adapters/repositories/schemas/contextReference.model';
import { InteractionModel } from '../../../../analytics/infrastructure/adapters/repositories/schemas/interaction.model';
import { ObservabilityTelemetryModel } from '../../../../analytics/infrastructure/adapters/repositories/schemas/observabilityTelemetry.model';
import { AutomationModel } from '../../../../automation/infrastructure/adapters/repositories/schemas/automation.model';
import { AutomationExecutionModel } from '../../../../automation/infrastructure/adapters/repositories/schemas/automationExecution.model';
import { CodeReviewExecutionModel } from '../../../../automation/infrastructure/adapters/repositories/schemas/codeReviewExecution.model';
import { TeamAutomationModel } from '../../../../automation/infrastructure/adapters/repositories/schemas/teamAutomation.model';
import { DryRunModel } from '../../../../dryRun/infrastructure/adapters/repositories/schemas/dryRun.model';
import { CodeReviewSettingsLogModel } from '../../../../ee/codeReviewSettingsLog/infrastructure/adapters/repository/schemas/codeReviewSettingsLog.model';
import { SSOConfigModel } from '../../../../ee/sso/repositories/ssoConfig.model';
import { AuthModel } from '../../../../identity/infrastructure/adapters/repositories/schemas/auth.model';
import { CliAuthSessionModel } from '../../../../identity/infrastructure/adapters/repositories/schemas/cli-auth-session.model';
import { PermissionsModel } from '../../../../identity/infrastructure/adapters/repositories/schemas/permissions.model';
import { ProfileModel } from '../../../../identity/infrastructure/adapters/repositories/schemas/profile.model';
import { ProfileConfigModel } from '../../../../identity/infrastructure/adapters/repositories/schemas/profileConfig.model';
import { UserModel } from '../../../../identity/infrastructure/adapters/repositories/schemas/user.model';
import { AuthIntegrationModel } from '../../../../integrations/infrastructure/adapters/repositories/schemas/authIntegration.model';
import { IntegrationModel } from '../../../../integrations/infrastructure/adapters/repositories/schemas/integration.model';
import { IntegrationConfigModel } from '../../../../integrations/infrastructure/adapters/repositories/schemas/integrationConfig.model';
import { IssuesModel } from '../../../../issues/infrastructure/adapters/repositories/schemas/issues.model';
import { SuggestionEmbeddedModel } from '../../../../kodyFineTuning/infrastructure/adapters/repositories/schemas/suggestionEmbedded.model';
import { KodyRulesModel } from '../../../../kodyRules/infrastructure/adapters/repositories/schemas/kodyRules.model';
import { GlobalParametersModel } from '../../../../organization/infrastructure/adapters/repositories/schemas/global-parameters.model';
import { OrganizationModel } from '../../../../organization/infrastructure/adapters/repositories/schemas/organization.model';
import { OrganizationParametersModel } from '../../../../organization/infrastructure/adapters/repositories/schemas/organizationParameters.model';
import { ParametersModel } from '../../../../organization/infrastructure/adapters/repositories/schemas/parameters.model';
import { TeamCliKeyModel } from '../../../../organization/infrastructure/adapters/repositories/schemas/team-cli-key.model';
import { CliDeviceModel } from '../../../../organization/infrastructure/adapters/repositories/schemas/cli-device.model';
import { TeamModel } from '../../../../organization/infrastructure/adapters/repositories/schemas/team.model';
import { TeamMemberModel } from '../../../../organization/infrastructure/adapters/repositories/schemas/teamMember.model';
import { PullRequestsModel } from '../../../../platformData/infrastructure/adapters/repositories/schemas/pullRequests.model';
import { SessionEventModel } from '../../../../cli-review/infrastructure/repositories/schemas/session-event.model';
import { RepositoryModel } from '../../../../code-review/infrastructure/adapters/repositories/schemas/repository.model';
import { AstNodeModel } from '../../../../code-review/infrastructure/adapters/repositories/schemas/astNode.model';
import { AstEdgeModel } from '../../../../code-review/infrastructure/adapters/repositories/schemas/astEdge.model';
import { InboxMessageModel } from '../../../workflow/infrastructure/repositories/schemas/inbox-message.model';
import { OutboxMessageModel } from '../../../workflow/infrastructure/repositories/schemas/outbox-message.model';
import { WorkflowJobModel } from '../../../workflow/infrastructure/repositories/schemas/workflow-job.model';
import { SSOTestSessionModel } from '@libs/ee/sso/repositories/ssoTestSession.model';
import { NotificationDeliveryModel } from '../../../../notifications/infrastructure/repositories/schemas/notification-delivery.model';
import { UserNotificationModel } from '../../../../notifications/infrastructure/repositories/schemas/user-notification.model';
import { RoutingRuleModel } from '../../../../notifications/infrastructure/repositories/schemas/routing-rule.model';

export const ENTITIES = [
    DryRunModel,
    TeamModel,
    OrganizationModel,
    UserModel,
    ContextReferenceModel,
    SuggestionEmbeddedModel,
    AuthIntegrationModel,
    PullRequestsModel,
    ParametersModel,
    ObservabilityTelemetryModel,
    AuthModel,
    CliAuthSessionModel,
    TeamMemberModel,
    TeamCliKeyModel,
    IntegrationConfigModel,
    OutboxMessageModel,
    CodeReviewSettingsLogModel,
    AutomationModel,
    OrganizationParametersModel,
    WorkflowJobModel,
    InboxMessageModel,
    GlobalParametersModel,
    TeamAutomationModel,
    PermissionsModel,
    IssuesModel,
    AutomationExecutionModel,
    ProfileConfigModel,
    IntegrationModel,
    KodyRulesModel,
    SSOConfigModel,
    SSOTestSessionModel,
    ProfileModel,
    CodeReviewExecutionModel,
    InteractionModel,
    CliDeviceModel,
    SessionEventModel,
    RepositoryModel,
    AstNodeModel,
    AstEdgeModel,
    NotificationDeliveryModel,
    UserNotificationModel,
    RoutingRuleModel,
];
