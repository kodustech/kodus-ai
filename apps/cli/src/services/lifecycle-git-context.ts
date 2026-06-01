type GitContextService = {
    getCurrentBranch(): Promise<string>;
    getHeadSha(): Promise<string | null>;
    getRemoteUrl(): Promise<string | null>;
};

export async function getBranchSafe(
    gitService: Pick<GitContextService, 'getCurrentBranch'>,
): Promise<string> {
    try {
        return (await gitService.getCurrentBranch()).trim();
    } catch {
        return '';
    }
}

export async function getHeadSafe(
    gitService: Pick<GitContextService, 'getHeadSha'>,
): Promise<string> {
    return (await gitService.getHeadSha()) ?? '';
}

export async function getRemoteSafe(
    gitService: Pick<GitContextService, 'getRemoteUrl'>,
): Promise<string> {
    return (await gitService.getRemoteUrl()) ?? '';
}

export async function getGitContext(
    gitService: GitContextService,
): Promise<{ branch: string; head: string; remote: string }> {
    const [branch, head, remote] = await Promise.all([
        getBranchSafe(gitService),
        getHeadSafe(gitService),
        getRemoteSafe(gitService),
    ]);

    return { branch, head, remote };
}
