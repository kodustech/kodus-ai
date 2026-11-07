import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';
import { approvalPathsOf } from './approval-decision';

export interface ApprovalFileConditions {
    includedFiles?: string[];
    excludedFiles?: string[];
    maxChangedLines?: number;
    lineCountExcludedFiles?: string[];
}

export interface ApprovalChangedFile {
    filename?: string;
    previous_filename?: string;
    status?: string;
    additions?: number;
    deletions?: number;
    patch?: string;
    isBinary?: boolean;
    lineCountVerified?: boolean;
}

/** Condition results do not authorize approval; review/risk and policy eligibility still apply. */
export type ApprovalFileConditionResult =
    | { matches: true; countedLines?: number }
    | {
          matches: false;
          code:
              | 'files-unavailable'
              | 'outside-included-files'
              | 'excluded-file'
              | 'line-count-unavailable'
              | 'line-limit-exceeded';
      };

export function evaluateApprovalFileConditions(
    conditions: ApprovalFileConditions,
    files: readonly ApprovalChangedFile[] | undefined,
): ApprovalFileConditionResult {
    const needsFiles = !!(
        conditions.includedFiles?.length ||
        conditions.excludedFiles?.length ||
        conditions.maxChangedLines !== undefined
    );
    if (!needsFiles) return { matches: true };
    if (
        conditions.maxChangedLines !== undefined &&
        (!Number.isSafeInteger(conditions.maxChangedLines) ||
            conditions.maxChangedLines < 0)
    ) {
        return { matches: false, code: 'line-count-unavailable' };
    }
    if (
        !files?.length ||
        files.some(
            (file) =>
                typeof file.filename !== 'string' ||
                !file.filename ||
                (file.previous_filename !== undefined &&
                    typeof file.previous_filename !== 'string'),
        )
    ) {
        return { matches: false, code: 'files-unavailable' };
    }
    const paths = approvalPathsOf([...files]);
    if (
        conditions.includedFiles?.length &&
        paths.some(
            (path) => !isFileMatchingGlob(path, conditions.includedFiles),
        )
    ) {
        return { matches: false, code: 'outside-included-files' };
    }
    if (
        paths.some((path) =>
            isFileMatchingGlob(path, conditions.excludedFiles ?? []),
        )
    ) {
        return { matches: false, code: 'excluded-file' };
    }
    if (conditions.maxChangedLines === undefined) return { matches: true };
    let countedLines = 0;
    for (const file of files) {
        const filePaths = approvalPathsOf([file]);
        // A rename out of an excluded lockfile path must not hide a counted
        // code change. Exclude the file's lines only if all its paths qualify.
        if (
            filePaths.every((path) =>
                isFileMatchingGlob(
                    path,
                    conditions.lineCountExcludedFiles ?? [],
                ),
            )
        )
            continue;
        if (
            file.isBinary ||
            file.lineCountVerified === false ||
            (file.status &&
                file.status !== 'renamed' &&
                !file.patch &&
                file.additions === 0 &&
                file.deletions === 0)
        ) {
            return { matches: false, code: 'line-count-unavailable' };
        }
        if (
            ![file.additions, file.deletions].every(
                (value) => Number.isSafeInteger(value) && value >= 0,
            )
        ) {
            return { matches: false, code: 'line-count-unavailable' };
        }
        countedLines += file.additions + file.deletions;
        if (!Number.isSafeInteger(countedLines))
            return { matches: false, code: 'line-count-unavailable' };
    }
    return countedLines > conditions.maxChangedLines
        ? { matches: false, code: 'line-limit-exceeded' }
        : { matches: true, countedLines };
}
