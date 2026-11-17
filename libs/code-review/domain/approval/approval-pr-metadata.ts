import { createHash } from 'node:crypto';

/** A policy can depend on labels, author or PR text without the head changing. */
export function approvalPrMetadataKey(pr: {
    title?: string;
    body?: string;
    labels?: string[];
    user?: { login?: string };
}): string {
    return createHash('sha256')
        .update(
            JSON.stringify({
                title: pr.title ?? '',
                body: pr.body ?? '',
                author: pr.user?.login ?? '',
                labels: pr.labels ? [...pr.labels].sort() : null,
            }),
        )
        .digest('hex');
}
