import { IKodyRule } from '@/core/domain/kodyRules/interfaces/kodyRules.interface';
import * as picomatch from 'picomatch';

/**
 * Checks if a file matches any of the provided Glob patterns.
 * @param filename Name of the file to be checked.
 * @param patterns Array of Glob patterns.
 * @returns Boolean indicating whether the file matches any pattern.
 */
export const isFileMatchingGlob = (
    filename: string,
    patterns: string[],
): boolean => {
    if (!patterns || patterns.length === 0) {
        return false;
    }

    // Compile the patterns once for better performance
    const matchers = patterns.map((pattern) =>
        picomatch(pattern, { dot: true }),
    );

    // Check if any matcher matches the filename
    return matchers.some((matcher) => matcher(filename));
};

/**
 * Retrieves the specific Kody rules for a file based on glob patterns.
 * @param filename Name of the file to be checked.
 * @param kodyRules Array of objects containing the pattern and Kody rules.
 * @returns Array of Kody rules applicable to the file.
 */
export const getKodyRulesForFile = (
    filename: string,
    kodyRules: Partial<IKodyRule>[],
): Partial<IKodyRule>[] => {
    if (!kodyRules?.length) {
        return [];
    }

    // Normalize the path by replacing backslashes with forward slashes (in case it's on Windows)
    const normalizedFilename = filename?.replace(/\\/g, '/');

    return kodyRules?.filter(
        (rule) =>
            !rule?.path ||
            rule?.path?.trim() === '' ||
            isFileMatchingGlob(normalizedFilename, [rule?.path]),
    );
};
