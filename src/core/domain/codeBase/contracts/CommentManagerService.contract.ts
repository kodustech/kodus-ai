import {
    CodeReviewConfig,
    CodeSuggestion,
    Comment,
    CommentResult,
    FileChange,
    SummaryConfig,
} from '@/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';

export const COMMENT_MANAGER_SERVICE_TOKEN = Symbol('CommentManagerService');

export interface ICommentManagerService {
    createInitialComment(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string },
        changedFiles: FileChange[],
        language: string,
        platformType: string,
    ): Promise<{ commentId: number; noteId: number; threadId?: number }>;

    generateSummaryPR(
        pullRequest: any,
        repository: { name: string; id: string },
        comments: any[],
        organizationAndTeamData: OrganizationAndTeamData,
        languageResultPrompt: string,
        summaryConfig: SummaryConfig,
    ): Promise<string>;

    updateOverallComment(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string },
        commentId: number,
        noteId: number,
        platformType: string,
        codeSuggestions?: Array<CommentResult>,
        codeReviewConfig?: CodeReviewConfig,
        threadId?: number,
    ): Promise<void>;

    updateSummarizationInPR(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string },
        summary: string,
    ): Promise<void>;

    createLineComments(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string; language: string },
        lineComments: Comment[],
        language: string,
    ): Promise<{
        lastAnalyzedCommit: any;
        commits: any[];
        commentResults: Array<CommentResult>;
    }>;

    generateSummaryMarkdown(
        changedFiles: FileChange[],
        description: string,
    ): string;

    repeatedCodeReviewSuggestionClustering(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        suggestions: any[],
    ): Promise<any>;

    enrichParentSuggestionsWithRelated(
        suggestions: CodeSuggestion[],
    ): Promise<CodeSuggestion[]>;
}
