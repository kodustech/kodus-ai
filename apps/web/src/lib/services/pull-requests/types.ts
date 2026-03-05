export interface Author {
    id: string;
    username: string;
    name: string;
}

export interface AutomationExecution {
    uuid: string;
    status:
        | "success"
        | "error"
        | "in_progress"
        | "pending"
        | "skipped"
        | "partial_error";
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
    origin: string;
}

export interface CodeReviewTimelineItem {
    uuid: string;
    createdAt: string;
    updatedAt: string;
    status: "in_progress" | "success" | "error" | "skipped" | "partial_error";
    message: string;
    stageName?: string | null;
    stageLabel?: string | null;
    metadata?:
        | {
              label?: string | null;
              visibility?: string | null;
              partialErrors?: Array<
                  | string
                  | {
                        path?: string;
                        file?: string;
                        message?: string;
                    }
              > | null;
              cta?: {
                  label: string;
                  href: string;
                  external?: boolean;
              } | null;
          }
        | Record<string, any>
        | null;
    finishedAt?: string | null;
}

export interface PullRequestExecution {
    prId: string;
    prNumber: number;
    title: string;
    status: "open" | "closed" | "merged";
    merged: boolean;
    url: string;
    baseBranchRef: string;
    headBranchRef: string;
    repositoryName: string;
    repositoryId: string;
    openedAt: string;
    closedAt: string;
    createdAt: string;
    updatedAt: string;
    provider: "GITHUB" | "GITLAB" | "BITBUCKET" | "AZURE_REPOS";
    author: Author;
    isDraft: boolean;
    automationExecution: AutomationExecution | null;
    codeReviewTimeline: CodeReviewTimelineItem[];
    enrichedData: Record<string, any>;
    suggestionsCount: { sent: number; filtered: number };
    reviewedCommitSha?: string | null;
    reviewedCommitUrl?: string | null;
    compareUrl?: string | null;
    executionId?: string | null;
}

export type PullRequestExecutionsPayload =
    | PullRequestExecution[]
    | {
          data?: PullRequestExecution[] | null;
          _page_data?: PullRequestExecution[] | null;
      }
    | null
    | undefined;

export interface PullRequestExecutionsResponse {
    data: PullRequestExecutionsPayload;
    statusCode: number;
    type: "Array" | string;
}
