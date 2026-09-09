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
    validateImplementedSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        byokConfig: NormalizedModel | undefined,
        codePatch: any,
        codeSuggestions: Partial<CodeSuggestion>[],
    ): Promise<Partial<CodeSuggestion>[]>;
    severityAnalysisAssignment(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        codeSuggestions: CodeSuggestion[],
        byokConfig: NormalizedModel,
    ): Promise<Partial<CodeSuggestion>[]>;
}
