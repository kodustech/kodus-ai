import type { ContextLayer } from '@libs/ai-engine/infrastructure/adapters/services/context/context-pack';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { IExternalPromptContext } from '../interfaces/promptExternalReference.interface';
import { PromptExternalReferenceEntity } from '../entities/promptExternalReference.entity';

export const PROMPT_CONTEXT_LOADER_SERVICE_TOKEN =
    'PROMPT_CONTEXT_LOADER_SERVICE_TOKEN';

export interface LoadContextParams {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: {
        id: string;
        name: string;
    };
    pullRequest: {
        head?: {
            sha: string;
        };
        number: number;
        [key: string]: unknown;
    };
    allReferences: PromptExternalReferenceEntity[];
}

export interface IPromptContextLoaderService {
    loadExternalContext(
        params: LoadContextParams,
        options?: { buildLayers?: boolean },
    ): Promise<{
        externalContext: IExternalPromptContext;
        contextLayers?: ContextLayer[];
    }>;
}
