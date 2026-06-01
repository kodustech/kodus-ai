export function buildNoChangesMessages(
    files: string[],
    options: {
        staged?: boolean;
        branch?: string;
        commit?: string;
    },
): string[] {
    if (files.length > 0) {
        return [
            'None of the requested files have diff content in the selected scope.',
            'Check the file paths or try running `kodus review` without explicit files.',
        ];
    }

    if (options.branch) {
        return [
            `No diff was found against \`${options.branch}\`.`,
            'Confirm the branch name or try a different base branch.',
        ];
    }

    if (options.commit) {
        return [
            `No diff was found for commit \`${options.commit}\`.`,
            'Confirm the commit SHA or review a different revision.',
        ];
    }

    if (options.staged) {
        return [
            'There are no staged changes to review.',
            'Stage files first or run `kodus review` to inspect the full working tree.',
        ];
    }

    return [
        'Try `kodus review --staged` to review staged changes only.',
        'Or pass files explicitly, for example: `kodus review src/file.ts`.',
    ];
}
