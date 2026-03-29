export const DEFAULT_PR_TITLE = 'Kodus automated changes';
export const DEFAULT_COMMIT_MESSAGE = 'chore: update files';
export const DEFAULT_SOURCE_BRANCH_PREFIX = 'kodus-pr';

export function buildDefaultSourceBranchName(): string {
    return `${DEFAULT_SOURCE_BRANCH_PREFIX}-${Date.now()}`;
}
