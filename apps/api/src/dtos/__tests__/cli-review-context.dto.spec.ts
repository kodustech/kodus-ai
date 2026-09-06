import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CliReviewRequestDto } from '../cli-review.dto';
import {
    REVIEW_CONTEXT_CONTENT_TYPE,
    REVIEW_CONTEXT_MAX_BYTES,
    REVIEW_CONTEXT_SOURCE,
} from '@libs/cli-review/domain/types/review-context.types';

function requestWithBody(body: unknown): CliReviewRequestDto {
    return plainToInstance(CliReviewRequestDto, {
        diff: 'diff --git a/file.ts b/file.ts\n+const value = 1;',
        reviewContext: {
            source: REVIEW_CONTEXT_SOURCE,
            contentType: REVIEW_CONTEXT_CONTENT_TYPE,
            body,
        },
    });
}

const productionPipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: true },
});

function transformRequest(reviewContext: unknown): Promise<unknown> {
    return productionPipe.transform(
        {
            diff: 'diff --git a/file.ts b/file.ts\n+const value = 1;',
            reviewContext,
        },
        { type: 'body', metatype: CliReviewRequestDto },
    );
}

describe('CliReviewRequestDto reviewContext', () => {
    it('accepts a UTF-8 context body at the 12 KiB byte boundary', async () => {
        const errors = await validate(
            requestWithBody('x'.repeat(REVIEW_CONTEXT_MAX_BYTES)),
        );

        expect(errors).toHaveLength(0);
    });

    it('keeps reviewContext optional for existing clients', async () => {
        const dto = plainToInstance(CliReviewRequestDto, {
            diff: 'diff --git a/file.ts b/file.ts\n+const value = 1;',
        });

        expect(await validate(dto)).toHaveLength(0);
    });

    it.each([
        { name: 'empty', body: '', message: 'must not be empty' },
        {
            name: 'NUL-containing',
            body: 'before\u0000after',
            message: 'must not contain NUL',
        },
        {
            name: 'oversized in UTF-8 bytes',
            body: '😀'.repeat(REVIEW_CONTEXT_MAX_BYTES / 4 + 1),
            message: 'must not exceed 12288 UTF-8 bytes',
        },
        {
            name: 'non-string',
            body: { packet: true },
            message: 'body must be a string',
        },
    ])('rejects a $name body', async ({ body, message }) => {
        const errors = await validate(requestWithBody(body));

        expect(JSON.stringify(errors)).toContain(message);
    });

    it('rejects unknown source and content type values', async () => {
        const dto = plainToInstance(CliReviewRequestDto, {
            diff: 'diff',
            reviewContext: {
                source: 'repository-file',
                contentType: 'application/octet-stream',
                body: 'context',
            },
        });

        const errors = await validate(dto);

        expect(JSON.stringify(errors)).toContain(REVIEW_CONTEXT_SOURCE);
        expect(JSON.stringify(errors)).toContain(REVIEW_CONTEXT_CONTENT_TYPE);
    });

    it('uses the production pipe without coercing malformed bodies to strings', async () => {
        for (const body of [42, true, { packet: true }, ['packet'], null]) {
            await expect(
                transformRequest({
                    source: REVIEW_CONTEXT_SOURCE,
                    contentType: REVIEW_CONTEXT_CONTENT_TYPE,
                    body,
                }),
            ).rejects.toThrow();
        }
    });

    it('accepts a valid Unicode body through the production pipe', async () => {
        await expect(
            transformRequest({
                source: REVIEW_CONTEXT_SOURCE,
                contentType: REVIEW_CONTEXT_CONTENT_TYPE,
                body: 'inspect cleanup 😀',
            }),
        ).resolves.toMatchObject({
            reviewContext: { body: 'inspect cleanup 😀' },
        });
    });
});
