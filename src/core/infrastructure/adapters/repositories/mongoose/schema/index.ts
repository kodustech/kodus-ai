import {
    AgentExecutionModel,
    AgentExecutionSchema,
} from './agent-execution.model';
import { InteractionModel, InteractionSchema } from './interaction.model';
import {
    CheckinHistoryModel,
    CheckinHistorySchema,
} from './checkinHistory.model';
import { LogModel, LogSchema } from './log.model';
import { MemoryModel, MemorySchema } from './memory.model';
import { SessionModel, SessionSchema } from './session.model';
import { TeamArtifactsModel, TeamArtifactsSchema } from './teamArtifact.model';
import {
    OrganizationArtifactsModel,
    OrganizationArtifactsSchema,
} from './organizationArtifact.model';
import {
    CheckinHistoryOrganizationModel,
    CheckinHistoryOrganizationSchema,
} from './checkinHistoryOrganization.model';
import { SnoozedItemModel, SnoozedItemSchema } from './snoozedItem.model';
import { ConversationModel, ConversationSchema } from './conversation.model';
import {
    CodeReviewFeedbackModel,
    CodeReviewFeedbackSchema,
} from './codeReviewFeedback.model';

export const MemoryModelInstance = {
    name: MemoryModel.name,
    schema: MemorySchema,
};

export const SessionModelInstance = {
    name: SessionModel.name,
    schema: SessionSchema,
};

export const LogModelInstance = {
    name: LogModel.name,
    schema: LogSchema,
};

export const AgentExecutionModelInstance = {
    name: AgentExecutionModel.name,
    schema: AgentExecutionSchema,
};

export const TeamArtifactsModelInstance = {
    name: TeamArtifactsModel.name,
    schema: TeamArtifactsSchema,
};

export const CheckinHistoryModelInstance = {
    name: CheckinHistoryModel.name,
    schema: CheckinHistorySchema,
};

export const CheckinHistoryOrganizationModelInstance = {
    name: CheckinHistoryOrganizationModel.name,
    schema: CheckinHistoryOrganizationSchema,
};

export const CodeReviewFeedbackModelInstance = {
    name: CodeReviewFeedbackModel.name,
    schema: CodeReviewFeedbackSchema,
};

export const InteractionModelInstance = {
    name: InteractionModel.name,
    schema: InteractionSchema,
};

export const OrganizationArtifactsModelInstance = {
    name: OrganizationArtifactsModel.name,
    schema: OrganizationArtifactsSchema,
};

export const SnoozedItemsModelInstance = {
    name: SnoozedItemModel.name,
    schema: SnoozedItemSchema,
};

export const ConversationModelInstance = {
    name: ConversationModel.name,
    schema: ConversationSchema,
};
