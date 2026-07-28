import { validate, ValidationError } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { PullRequestMessagesUpsertDto } from '../pull-request-messages-upsert.dto';
import {
    ConfigLevel,
    PullRequestMessageStatus,
} from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';

// Mirror the app's global ValidationPipe. `forbidNonWhitelisted` is what
// produced the "property errorReviewMessage should not exist" 400 before the
// field was added to the DTO (issue #1452 error message).
const VALIDATION_OPTIONS = {
    whitelist: true,
    forbidNonWhitelisted: true,
};

const toDto = (plain: Record<string, unknown>): PullRequestMessagesUpsertDto =>
    plainToInstance(PullRequestMessagesUpsertDto, plain);

const message = (over: Record<string, unknown> = {}) => ({
    content: 'Reach out to @platform-support',
    status: PullRequestMessageStatus.ACTIVE,
    ...over,
});

// Recursively collect every property name that failed, including nested ones,
// so assertions don't depend on where in the tree the error surfaced.
const failedProperties = (errors: ValidationError[]): string[] =>
    errors.flatMap((e) => [
        e.property,
        ...(e.children ? failedProperties(e.children) : []),
    ]);

describe('PullRequestMessagesUpsertDto', () => {
    const base = { configLevel: ConfigLevel.GLOBAL };

    it('accepts a payload carrying errorReviewMessage (regression: the upsert endpoint 400ed on this property before it was whitelisted)', async () => {
        const errors = await validate(
            toDto({ ...base, errorReviewMessage: message() }),
            VALIDATION_OPTIONS,
        );

        expect(errors).toHaveLength(0);
    });

    it('accepts start, end and error messages together', async () => {
        const errors = await validate(
            toDto({
                ...base,
                startReviewMessage: message(),
                endReviewMessage: message(),
                errorReviewMessage: message(),
            }),
            VALIDATION_OPTIONS,
        );

        expect(errors).toHaveLength(0);
    });

    it('validates the nested errorReviewMessage status (invalid enum is rejected)', async () => {
        const errors = await validate(
            toDto({
                ...base,
                errorReviewMessage: { content: 'x', status: 'not-a-status' },
            }),
            VALIDATION_OPTIONS,
        );

        expect(errors.length).toBeGreaterThan(0);
        expect(failedProperties(errors)).toContain('errorReviewMessage');
    });

    it('rejects an errorReviewMessage missing its content', async () => {
        const errors = await validate(
            toDto({
                ...base,
                errorReviewMessage: {
                    status: PullRequestMessageStatus.ACTIVE,
                },
            }),
            VALIDATION_OPTIONS,
        );

        expect(errors.length).toBeGreaterThan(0);
        expect(failedProperties(errors)).toContain('errorReviewMessage');
    });

    it('still rejects a genuinely unknown property (proves forbidNonWhitelisted — the mechanism behind the original 400)', async () => {
        const errors = await validate(
            toDto({ ...base, bogusField: 'nope' }),
            VALIDATION_OPTIONS,
        );

        expect(errors.length).toBeGreaterThan(0);
        expect(failedProperties(errors)).toContain('bogusField');
    });
});
