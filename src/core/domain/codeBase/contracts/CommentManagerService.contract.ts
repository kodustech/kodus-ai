import {
    CodeReviewConfig,
    CodeSuggestion,
    Comment,
    CommentResult,
    FileChange,
    SummaryConfig,
} from '@/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { BYOKConfig, LLMModelProvider } from '@kodus/kodus-common/llm';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { ISuggestionByPR } from '../../pullRequests/interfaces/pullRequests.interface';
import {
    IPullRequestMessageContent,
    IPullRequestMessages,
} from '../../pullRequestMessages/interfaces/pullRequestMessages.interface';
import { CodeReviewPipelineContext } from '@/core/infrastructure/adapters/services/codeBase/codeReviewPipeline/context/code-review-pipeline.context';

export const COMMENT_MANAGER_SERVICE_TOKEN = Symbol('CommentManagerService');

export interface ICommentManagerService {
    createInitialComment(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string },
        changedFiles: FileChange[],
        language: string,
        platformType: string,
        codeReviewConfig?: CodeReviewConfig,
        pullRequestMessages?: IPullRequestMessages,
        dryRun?: CodeReviewPipelineContext['dryRun'],
    ): Promise<{ commentId: number; noteId: number; threadId?: number }>;

    processEndReviewMessageTemplate(
        template: string,
        changedFiles: FileChange[],
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        codeReviewConfig?: CodeReviewConfig,
        language?: string,
        platformType?: PlatformType,
    ): Promise<string>;

    generateSummaryPR(
        pullRequest: any,
        repository: { name: string; id: string },
        changedFiles: Partial<FileChange>[],
        organizationAndTeamData: OrganizationAndTeamData,
        languageResultPrompt: string,
        summaryConfig: SummaryConfig,
        byokConfig?: BYOKConfig,
        isCommitRun?: boolean,
        prPreview?: boolean,
        externalPromptContext?: any,
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
        finalCommentBody?: string,
        dryRun?: CodeReviewPipelineContext['dryRun'],
    ): Promise<void>;

    updateSummarizationInPR(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string },
        summary: string,
        dryRun: CodeReviewPipelineContext['dryRun'],
    ): Promise<void>;

    createLineComments(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string; language: string },
        lineComments: Comment[],
        language: string,
        dryRun: CodeReviewPipelineContext['dryRun'],
        suggestionCopyPrompt?: boolean,
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
        byokConfig?: BYOKConfig,
    ): Promise<any>;

    enrichParentSuggestionsWithRelated(
        suggestions: CodeSuggestion[],
    ): Promise<CodeSuggestion[]>;

    createPrLevelReviewComments(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string; language: string },
        prLevelSuggestions: ISuggestionByPR[],
        language: string,
        suggestionCopyPrompt?: boolean,
        dryRun?: CodeReviewPipelineContext['dryRun'],
    ): Promise<{ commentResults: Array<CommentResult> }>;

    findLastReviewComment(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string },
        platformType: PlatformType,
    ): Promise<{ commentId: number; nodeId?: string } | null>;

    minimizeLastReviewComment(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string },
        platformType: PlatformType,
    ): Promise<boolean>;

    createComment(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string },
        platformType: PlatformType,
        changedFiles?: FileChange[],
        language?: string,
        codeSuggestions?: Array<CommentResult>,
        codeReviewConfig?: CodeReviewConfig,
        endReviewMessage?: string,
        pullRequestMessagesConfig?: IPullRequestMessages,
        dryRun?: CodeReviewPipelineContext['dryRun'],
    ): Promise<void>;

    createNoChangesComment(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { name: string; id: string },
        platformType: string,
        language: string,
        dryRun?: CodeReviewPipelineContext['dryRun'],
    ): Promise<void>;
}
