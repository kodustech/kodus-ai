import path from 'node:path';

export type GitFileReadOptions = {
    staged?: boolean;
    commit?: string;
    branch?: string;
    repoRoot?: string;
    relativePrefix?: string;
};

function resolveTargetPath(
    filePath: string,
    options?: Pick<GitFileReadOptions, 'repoRoot' | 'relativePrefix'>,
): string {
    if (!options?.repoRoot) {
        return filePath;
    }
    return options.relativePrefix
        ? path.resolve(options.repoRoot, options.relativePrefix, filePath)
        : path.resolve(options.repoRoot, filePath);
}

function resolveGitObjectPath(
    filePath: string,
    options?: Pick<GitFileReadOptions, 'relativePrefix'>,
): string {
    return options?.relativePrefix
        ? `${options.relativePrefix}${filePath}`
        : filePath;
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
    const targetPath = resolveTargetPath(filePath, options);

    if (options?.branch) {
        return {
            mode: 'single-diff',
            args: [`${options.branch}...HEAD`, '--', targetPath],
        };
    }

    if (options?.commit) {
        return {
            mode: 'single-diff',
            args: [`${options.commit}^`, options.commit, '--', targetPath],
        };
    }

    if (options?.staged) {
        return {
            mode: 'single-diff',
            args: ['--cached', '--', targetPath],
        };
    }

    return {
        mode: 'working-tree-diff',
        stagedArgs: ['--cached', '--', targetPath],
        unstagedArgs: ['--', targetPath],
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
            args: [
                `${options.commit}:${resolveGitObjectPath(filePath, options)}`,
            ],
        };
    }

    if (options?.branch) {
        return {
            mode: 'git-show',
            args: [`HEAD:${resolveGitObjectPath(filePath, options)}`],
        };
    }

    return {
        mode: 'fs',
        path: resolveTargetPath(filePath, options),
        encoding: 'utf-8',
    };
}
