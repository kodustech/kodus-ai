export type Commit = {
    sha: string;
    commit: {
        author: {
            id?: string;
            name: string;
            email: string;
            // This field represents the timestamp when the author made the commit locally. Wereas created_at (from the commit)  typically represents the timestamp when the commit was created in the repository.
            date: string;
        };
        message: string;
    };
    parents?: Array<{ sha: string }>;
};
