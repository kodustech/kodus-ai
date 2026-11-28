import { Inject, Injectable, Optional } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import { authorTextOf } from '@libs/runtime/planner/intent-author';

import { type PullRequestAuthorDescriptionStore, type PullRequestKey, RUNTIME_PR_AUTHOR_DESCRIPTION_STORE } from '../domain/ports';

/**
 * The description a Run's intent reads (docs/runtime/intent-oracle.md "When the review replaced the description").
 * A code review set to replace the PR's description leaves only Kody's summary in the body, which the intent author
 * never reads (it is written from the diff and states a bug as intended). So every time the Runtime reads a PR, the
 * description its author wrote is kept, and a Run whose body holds no author text any more reads the last one kept.
 */
@Injectable()
export class RuntimePullRequestDescriptions {
    private readonly logger = createLogger(RuntimePullRequestDescriptions.name);

    constructor(
        // Optional: without the store a Run reads the body as the Git API answers it, as before.
        @Optional()
        @Inject(RUNTIME_PR_AUTHOR_DESCRIPTION_STORE)
        private readonly store?: PullRequestAuthorDescriptionStore,
    ) {}

    /** Keeps a description its author wrote; a body that is only Kody's summary is never kept. Never fails the caller. */
    async remember(key: PullRequestKey, description: string | undefined): Promise<void> {
        if (!this.store || !description || !authorTextOf(description)) return;
        await this.store.remember(key, description).catch((error: unknown) => this.lost('remember', key, error));
    }

    /** The PR's description when its author's text is still in it, else the last one its author wrote (none kept: the body as it is). */
    async forRun(key: PullRequestKey, description: string | undefined): Promise<string | undefined> {
        if (description && authorTextOf(description)) {
            await this.remember(key, description);
            return description;
        }
        if (!this.store) return description;
        const kept = await this.store.lastAuthored(key).catch((error: unknown) => {
            this.lost('read', key, error);
            return null;
        });
        return kept ?? description;
    }

    private lost(what: 'remember' | 'read', key: PullRequestKey, error: unknown) {
        this.logger.warn({
            message: `Runtime: the PR author's description could not be ${what === 'read' ? 'read' : 'kept'}; the Run reads the body as it is`,
            context: RuntimePullRequestDescriptions.name,
            error: error instanceof Error ? error : undefined,
            metadata: { organizationId: key.organizationId, repositoryId: key.repositoryId, prNumber: key.prNumber },
        });
    }
}
