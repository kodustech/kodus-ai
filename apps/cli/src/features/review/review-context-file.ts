import { readFile, stat } from 'node:fs/promises';
import type { ReviewContext } from '../../types/review.js';
import {
    REVIEW_CONTEXT_CONTENT_TYPE,
    REVIEW_CONTEXT_MAX_BYTES,
    REVIEW_CONTEXT_SOURCE,
} from '../../types/review.js';

export {
    REVIEW_CONTEXT_CONTENT_TYPE,
    REVIEW_CONTEXT_MAX_BYTES,
    REVIEW_CONTEXT_SOURCE,
};

export async function loadReviewContextFile(
    filePath: string,
): Promise<ReviewContext> {
    let bytes: Buffer;

    try {
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) {
            throw new Error('path is not a regular file');
        }
        if (fileStat.size > REVIEW_CONTEXT_MAX_BYTES) {
            throw new Error(
                `Review context file exceeds the 12 KiB limit (${fileStat.size} bytes)`,
            );
        }
        bytes = await readFile(filePath);
    } catch (error) {
        if (
            error instanceof Error &&
            error.message.startsWith('Review context file exceeds')
        ) {
            throw error;
        }
        throw new Error(`Unable to read review context file: ${filePath}`, {
            cause: error,
        });
    }

    if (bytes.length > REVIEW_CONTEXT_MAX_BYTES) {
        throw new Error(
            `Review context file exceeds the 12 KiB limit (${bytes.length} bytes)`,
        );
    }
    if (bytes.length === 0) {
        throw new Error('Review context file must not be empty');
    }
    if (bytes.includes(0)) {
        throw new Error('Review context file must not contain NUL bytes');
    }

    let body: string;
    try {
        body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
        throw new Error('Review context file must contain valid UTF-8', {
            cause: error,
        });
    }

    return {
        source: REVIEW_CONTEXT_SOURCE,
        contentType: REVIEW_CONTEXT_CONTENT_TYPE,
        body,
    };
}
