const VALID_FAIL_ON_SEVERITIES = new Set([
    'info',
    'warning',
    'error',
    'critical',
] as const);

export function validateReviewOptions(options: {
    interactive?: boolean;
    fix?: boolean;
    promptOnly?: boolean;
    failOn?: string;
}): void {
    if (options.interactive && options.promptOnly) {
        throw new Error(
            'The `--interactive` and `--prompt-only` options cannot be used together.',
        );
    }

    if (options.interactive && options.fix) {
        throw new Error(
            'The `--interactive` and `--fix` options cannot be used together.',
        );
    }

    if (options.failOn && !VALID_FAIL_ON_SEVERITIES.has(options.failOn as never)) {
        throw new Error(
            `Invalid value for \`--fail-on\`: \`${options.failOn}\`. Use one of: info, warning, error, critical.`,
        );
    }
}
