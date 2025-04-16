/**
 * Azure Repos Webhook Payload Root
 * Covers: ms.vss-code.git-pullrequest-comment-event, git.pullrequest.created, git.pullrequest.updated
 */
export interface AzureReposWebhookPayload {
  id: string;
  eventType: string;
  publisherId: string;
  scope?: string;
  message: AzureReposWebhookMessage;
  detailedMessage: AzureReposWebhookMessage;
  resource: AzureReposWebhookResource;
  resourceVersion: string;
  resourceContainers: AzureReposWebhookResourceContainers;
  createdDate: string;
}

/**
 * Message content (text, html, markdown)
 */
export interface AzureReposWebhookMessage {
  text: string;
  html: string;
  markdown: string;
}

/**
 * Resource container IDs
 */
export interface AzureReposWebhookResourceContainers {
  collection: { id: string };
  account: { id: string };
  project: { id: string };
}

/**
 * Resource: varies by eventType
 * For pull request comment event, contains comment and pullRequest
 * For pull request events, contains pullRequest
 */
export interface AzureReposWebhookResource {
  // For comment event
  comment?: AzureReposWebhookComment;
  pullRequest?: AzureReposWebhookPullRequest;
  // For PR created/updated
  repository?: AzureReposWebhookRepository;
  pullRequestId?: number;
  status?: string;
  createdBy?: AzureReposWebhookUser;
  creationDate?: string;
  closedDate?: string;
  title?: string;
  description?: string;
  sourceRefName?: string;
  targetRefName?: string;
  mergeStatus?: string;
  mergeId?: string;
  lastMergeSourceCommit?: AzureReposWebhookCommit;
  lastMergeTargetCommit?: AzureReposWebhookCommit;
  lastMergeCommit?: AzureReposWebhookCommit;
  reviewers?: AzureReposWebhookReviewer[];
  commits?: AzureReposWebhookCommit[];
  url?: string;
  _links?: AzureReposWebhookLinks;
}

/**
 * Pull Request object (as nested in resource.pullRequest or resource)
 */
export interface AzureReposWebhookPullRequest {
  repository: AzureReposWebhookRepository;
  pullRequestId: number;
  status: string;
  createdBy: AzureReposWebhookUser;
  creationDate: string;
  closedDate?: string;
  title: string;
  description: string;
  sourceRefName: string;
  targetRefName: string;
  mergeStatus: string;
  mergeId: string;
  lastMergeSourceCommit: AzureReposWebhookCommit;
  lastMergeTargetCommit: AzureReposWebhookCommit;
  lastMergeCommit: AzureReposWebhookCommit;
  reviewers: AzureReposWebhookReviewer[];
  commits?: AzureReposWebhookCommit[];
  url: string;
  _links: AzureReposWebhookLinks;
}

/**
 * Repository object
 */
export interface AzureReposWebhookRepository {
  id: string;
  name: string;
  url: string;
  project: AzureReposWebhookProject;
  defaultBranch: string;
  remoteUrl: string;
}

/**
 * Project object
 */
export interface AzureReposWebhookProject {
  id: string;
  name: string;
  url: string;
  state: string;
  visibility?: string;
  lastUpdateTime?: string;
}

/**
 * Comment object (for PR comment event)
 */
export interface AzureReposWebhookComment {
  id: number;
  parentCommentId: number;
  author: AzureReposWebhookUser;
  content: string;
  publishedDate: string;
  lastUpdatedDate: string;
  lastContentUpdatedDate: string;
  commentType: string;
  _links: AzureReposWebhookCommentLinks;
}

/**
 * User/Author/Reviewer
 */
export interface AzureReposWebhookUser {
  displayName: string;
  url: string;
  id: string;
  uniqueName: string;
  imageUrl: string;
  isContainer?: boolean;
}

/**
 * Reviewer object (extends User)
 */
export interface AzureReposWebhookReviewer extends AzureReposWebhookUser {
  reviewerUrl?: string | null;
  vote: number;
}

/**
 * Commit object
 */
export interface AzureReposWebhookCommit {
  commitId: string;
  url: string;
}

/**
 * Generic links object for PR, comment, etc
 */
export interface AzureReposWebhookLinks {
  [key: string]: { href: string };
}

/**
 * Links specific for comment
 */
export interface AzureReposWebhookCommentLinks {
  self: { href: string };
  repository: { href: string };
  threads: { href: string };
}
