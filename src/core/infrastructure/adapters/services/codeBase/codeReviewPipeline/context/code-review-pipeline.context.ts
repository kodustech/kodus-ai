import {
    AnalysisContext,
    CodeAnalysisAST,
    CodeReviewConfig,
    CodeSuggestion,
    CommentResult,
    FileChange,
    Repository,
} from '@/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { AutomationExecutionEntity } from '@/core/domain/automation/entities/automation-execution.entity';
import { IClusterizedSuggestion } from '@/ee/kodyFineTuning/domain/interfaces/kodyFineTuning.interface';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { PipelineContext } from '../../../pipeline/interfaces/pipeline-context.interface';

export interface CodeReviewPipelineContext extends PipelineContext {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: Repository;
    branch: string;
    pullRequest: {
        number: number;
        title: string;
        base: { ref: string };
        repository: Repository;
        [key: string]: any;
    };
    teamAutomationId: string;
    origin: string;
    action: string;
    platformType: PlatformType;

    codeReviewConfig?: CodeReviewConfig;

    changedFiles?: FileChange[];
    lastExecution?: {
        commentId?: any;
        noteId?: any;
        threadId?: any;
        lastAnalyzedCommit?: any;
    };
    pipelineMetadata?: {
        lastExecution?: AutomationExecutionEntity;
    };

    initialCommentData?: {
        commentId: number;
        noteId: number;
        threadId?: number;
    };

    batches: FileChange[][];

    clusterizedSuggestions?: IClusterizedSuggestion[];

    codeAnalysisAST?: CodeAnalysisAST;

    preparedFileContexts: AnalysisContext[];
    fileAnalysisResults?: Array<{
        validSuggestionsToAnalyze: Partial<CodeSuggestion>[];
        discardedSuggestionsBySafeGuard: Partial<CodeSuggestion>[];
        overallComment: { filepath: string; summary: string };
        file: FileChange;
    }>;

    validSuggestions: Partial<CodeSuggestion>[];
    discardedSuggestions: Partial<CodeSuggestion>[];
    overallComments: { filepath: string; summary: string }[];
    lastAnalyzedCommit?: any;

    lineComments?: CommentResult[];
}
