import type { ContextRequirement } from '@libs/ai-engine/infrastructure/adapters/services/context/context-pack';
import type { NormalizedModel } from '@libs/llm/byok-config';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IDetectedReference,
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
        byokConfig?: NormalizedModel;
        subscriptionStatus?: string;
        /** Earlier detections by fingerprint. A hit skips the model call; the
         *  references are still resolved against the repository. */
        detectionCache?: Record<string, IDetectedReference[]>;
    }): Promise<{
        references: IFileReference[];
        syncErrors?: IPromptReferenceSyncError[];
        promptHash: string;
        requirements: ContextRequirement[];
        markers: string[];
        /** Set only when the detection is safe to reuse: a hit, or a model
         *  answer that parsed. Absent after a failure or an unusable answer. */
        detection?: { fingerprint: string; references: IDetectedReference[] };
    }>;

    calculatePromptHash(promptText: string): string;
}
