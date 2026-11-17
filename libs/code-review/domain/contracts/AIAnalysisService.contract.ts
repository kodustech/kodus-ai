import type { ImplementationCheckSuggestion } from '@libs/common/utils/prompts';
import { ImplementationStatus } from '@libs/platformData/domain/pullRequests/enums/implementationStatus.enum';
import type { ImplementationUnmeasuredReason } from '@libs/platformData/domain/pullRequests/implementation-status';
import type { NormalizedModel } from '@libs/llm/byok-config';

import { CreateSandboxParams } from '@libs/sandbox/domain/contracts/sandbox.provider';
import {
    CrossFileContextSnippet,
    RemoteCommands,
} from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import {
    CodeSuggestion,
    DocumentationContextItem,
    ReviewModeResponse,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

/** What the model decided for one file's suggestions: a status, or why not. */
export type ImplementationCheckModelResult = {
    verdicts: { id: string; status: ImplementationStatus }[];
    unmeasured: { id: string; reason: ImplementationUnmeasuredReason }[];
};

export interface IAIAnalysisService {
    filterSuggestionsSafeGuard(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        file: any,
        relevantContent: string,
        codeDiff: string,
        suggestions: any[],
        languageResultPrompt: string,
        reviewMode: ReviewModeResponse,
        byokConfig: NormalizedModel,
        crossFileSnippets?: CrossFileContextSnippet[],
        remoteCommands?: RemoteCommands,
        memories?: Array<Partial<IKodyRule>>,
        externalReferences?: unknown[],
        externalReferenceErrors?: unknown[] | string,
        getFreshCloneParams?: () => Promise<CreateSandboxParams>,
        documentationContext?: DocumentationContextItem[],
    ): Promise<any>;
    checkSuggestionImplementation(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        byokConfig: NormalizedModel | undefined;
        file: { filename: string; patch: string };
        suggestions: ImplementationCheckSuggestion[];
    }): Promise<ImplementationCheckModelResult>;
    severityAnalysisAssignment(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        codeSuggestions: CodeSuggestion[],
        byokConfig: NormalizedModel,
    ): Promise<Partial<CodeSuggestion>[]>;
}
