export type GitFileReadOptions = {
    staged?: boolean;
    commit?: string;
    branch?: string;
    oldFilePath?: string;
};

function toTopLiteralPathspec(filePath: string): string {
    return `:(top,literal)${filePath}`;
}

export function buildFileDiffReadPlan(
    filePath: string,
    options?: GitFileReadOptions,
):
    | { mode: 'single-diff'; args: string[] }
    | {
          mode: 'working-tree-diff';
          stagedArgs: string[];
          unstagedArgs: string[];
      } {
    if (options?.branch) {
        return {
            mode: 'single-diff',
            args: [`${options.branch}...HEAD`, '--', filePath],
        };
    }

    if (options?.commit) {
        return {
            mode: 'single-diff',
            args: [`${options.commit}^`, options.commit, '--', filePath],
        };
    }

    if (options?.staged) {
        const targetPaths =
            options.oldFilePath && options.oldFilePath !== filePath
                ? [options.oldFilePath, filePath]
                : [filePath];
        return {
            mode: 'single-diff',
            args: [
                '--cached',
                '--',
                ...targetPaths.map((targetPath) =>
                    toTopLiteralPathspec(targetPath),
                ),
            ],
        };
    }

    return {
        mode: 'working-tree-diff',
        stagedArgs: ['--cached', '--', filePath],
        unstagedArgs: ['--', filePath],
    };
}

export function buildFileContentReadPlan(
    filePath: string,
    options?: GitFileReadOptions,
):
    | { mode: 'git-show'; args: string[] }
    | { mode: 'fs'; path: string; encoding: 'utf-8' } {
    if (options?.commit) {
        return {
            mode: 'git-show',
            args: [`${options.commit}:${filePath}`],
        };
    }

    if (options?.branch) {
        return {
            mode: 'git-show',
            args: [`HEAD:${filePath}`],
        };
    }

    if (options?.staged) {
        return {
            mode: 'git-show',
            args: [`:0:${filePath}`],
        };
    }

    return {
        mode: 'fs',
        path: filePath,
        encoding: 'utf-8',
    };
}
