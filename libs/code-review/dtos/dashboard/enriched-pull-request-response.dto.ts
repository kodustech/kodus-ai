import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import type { ReviewWarning } from '@libs/code-review/infrastructure/agents/llm/review-warnings';

export interface CodeReviewExecutionTimeline {
    uuid: string;
    createdAt: Date;
    updatedAt: Date;
    status: AutomationStatus;
    stageName?: string;
    stageLabel?: string;
    message?: string;
    metadata?: Record<string, any>;
    finishedAt?: Date;
}

export interface EnrichedPullRequestResponse {
    // Dados do PR (do MongoDB)
    prId: string;
    prNumber: number;
    title: string;
    status: string;
    merged: boolean;
    url: string;
    baseBranchRef: string;
    headBranchRef: string;
    repositoryName: string;
    repositoryId: string;
    openedAt: string;
    closedAt?: string;
    createdAt: string;
    updatedAt: string;
    provider: string;
    author: {
        id: string;
        username: string;
        name?: string;
    };
    isDraft: boolean;
    suggestionsCount: { sent: number; filtered: number };
    reviewedCommitSha?: string;
    reviewedCommitUrl?: string;
    compareUrl?: string;
    executionId?: string;

    // Dados da execução de automação (do PostgreSQL)
    automationExecution: {
        uuid: string;
        status: AutomationStatus;
        errorMessage?: string;
        createdAt: Date;
        updatedAt: Date;
        origin: string;
    };

    // Timeline de execuções de code review
    codeReviewTimeline: CodeReviewExecutionTimeline[];

    /**
     * Fidelity warnings emitted by the adaptive-fit logic when the
     * configured model's context window forced the pipeline to drop
     * something to fit (compact prompt, dropped callGraph, etc).
     * Surfaced in the web admin dashboard so operators can see when
     * reviews ran in a degraded mode. Absent for full-fidelity runs.
     */
    reviewWarnings?: ReviewWarning[];

    // Dados enriquecidos do dataExecution
    enrichedData?: {
        repository?: {
            id: string;
            name: string;
        };
        pullRequest?: {
            number: number;
            title: string;
            url?: string;
        };
        team?: {
            name: string;
            uuid: string;
        };
        automation?: {
            name: string;
            type: string;
        };
    };
}
