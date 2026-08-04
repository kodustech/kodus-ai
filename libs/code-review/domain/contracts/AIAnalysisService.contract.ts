import { LLMModelProvider } from '@libs/llm/model-providers';
import type { NormalizedByokConfig } from '@libs/llm/byok-config';

import { CreateSandboxParams } from '@libs/sandbox/domain/contracts/sandbox.provider';
import {
    CrossFileContextSnippet,
    RemoteCommands,
} from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import {
    AIAnalysisResult,
    AnalysisContext,
    CodeSuggestion,
    DocumentationContextItem,
    FileChange,
    FileChangeContext,
    ReviewModeResponse,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

export interface IAIAnalysisService {
    analyzeCodeWithAI(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        fileContext: FileChangeContext,
        reviewModeResponse: ReviewModeResponse,
        context: AnalysisContext,
        suggestions?: AIAnalysisResult,
    ): Promise<AIAnalysisResult>;
    analyzeCodeWithAI_v2(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        fileContext: FileChangeContext,
        reviewModeResponse: ReviewModeResponse,
        context: AnalysisContext,
        byokConfig: NormalizedByokConfig,
    ): Promise<AIAnalysisResult>;
    generateCodeSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        sessionId: string,
        question: string,
        parameters: any,
    );
    filterSuggestionsSafeGuard(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        file: any,
        relevantContent: string,
        codeDiff: string,
        suggestions: any[],
        languageResultPrompt: string,
        reviewMode: ReviewModeResponse,
        byokConfig: NormalizedByokConfig,
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
        provider: LLMModelProvider,
        codePatch: any,
        codeSuggestions: Partial<CodeSuggestion>[],
    ): Promise<Partial<CodeSuggestion>[]>;
    selectReviewMode(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        file: FileChange,
        codeDiff: string,
        byokConfig: NormalizedByokConfig,
    ): Promise<ReviewModeResponse>;
    severityAnalysisAssignment(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        codeSuggestions: CodeSuggestion[],
        byokConfig: NormalizedByokConfig,
    ): Promise<Partial<CodeSuggestion>[]>;
}
