import type { ContextRequirement } from '@libs/ai-engine/infrastructure/adapters/services/context/context-pack';
import { BYOKConfig } from '@kodus/kodus-common/llm';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IFileReference,
    IPromptReferenceSyncError,
    PromptSourceType,
} from '../interfaces/promptExternalReference.interface';

export const PROMPT_CONTEXT_ENGINE_SERVICE_TOKEN =
    'PROMPT_CONTEXT_ENGINE_SERVICE_TOKEN';

export interface IPromptContextEngineService {
    detectAndResolveReferences(params: {
        requirementId: string;
        path: string[];
        sourceType: PromptSourceType;
        promptText: string;
        repositoryId: string;
        repositoryName: string;
        organizationAndTeamData: OrganizationAndTeamData;
        context?: 'rule' | 'instruction' | 'prompt';
        detectionMode?: 'rule' | 'prompt';
        byokConfig?: BYOKConfig;
        subscriptionStatus?: string;
    }): Promise<{
        references: IFileReference[];
        syncErrors?: IPromptReferenceSyncError[];
        promptHash: string;
        requirements: ContextRequirement[];
        markers: string[];
    }>;

    calculatePromptHash(promptText: string): string;
}
