import { describe, expect, it } from 'vitest';
import { validateReviewOptions } from '../options.js';

describe('validateReviewOptions', () => {
    it('accepts valid combinations', () => {
        expect(() =>
            validateReviewOptions({
                interactive: false,
                fix: false,
                promptOnly: false,
                failOn: 'error',
            }),
        ).not.toThrow();
    });

    it('rejects interactive with prompt-only', () => {
        expect(() =>
            validateReviewOptions({
                interactive: true,
                promptOnly: true,
            }),
        ).toThrow(
            'The `--interactive` and `--prompt-only` options cannot be used together.',
        );
    });

    it('rejects interactive with fix', () => {
        expect(() =>
            validateReviewOptions({
                interactive: true,
                fix: true,
            }),
        ).toThrow(
            'The `--interactive` and `--fix` options cannot be used together.',
        );
    });

    it('rejects invalid fail-on severities with the allowed values', () => {
        expect(() =>
            validateReviewOptions({
                failOn: 'fatal',
            }),
        ).toThrow(
            'Invalid value for `--fail-on`: `fatal`. Use one of: info, warning, error, critical.',
        );
    });
});
