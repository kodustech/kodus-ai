export type GitlabDraftLike = {
    readonly draft?: boolean | null;
    readonly work_in_progress?: boolean | null;
};

export type GitlabDraftChangeLike = {
    readonly previous?: boolean | null;
    readonly current?: boolean | null;
};

export type GitlabDraftChangesLike = {
    readonly draft?: GitlabDraftChangeLike;
    readonly work_in_progress?: GitlabDraftChangeLike;
};

export const resolveGitlabDraftStatus = (
    mergeRequest?: GitlabDraftLike | null,
): boolean =>
    mergeRequest?.draft ?? mergeRequest?.work_in_progress ?? false;

export const isGitlabDraftToReadyChange = (
    changes?: GitlabDraftChangesLike | null,
): boolean => {
    const draftChange = changes?.draft;

    if (draftChange?.previous === true && draftChange?.current === false) {
        return true;
    }

    const hasCompleteDraftChange =
        typeof draftChange?.previous === 'boolean' &&
        typeof draftChange?.current === 'boolean';

    if (hasCompleteDraftChange) {
        return false;
    }

    const workInProgressChange = changes?.work_in_progress;
    return (
        workInProgressChange?.previous === true &&
        workInProgressChange?.current === false
    );
};
