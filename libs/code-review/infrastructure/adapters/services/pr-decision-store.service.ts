import { Inject, Injectable } from '@nestjs/common';

import type {
    LoadPrDecisionsParams,
    PrDecisionOutcome,
    PrDecisionRecord,
    PrDecisionStore,
} from '@libs/code-review/domain/contracts/pr-decision-store.contract';
import { createLogger } from '@libs/core/log/logger';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { ImplementationStatus } from '@libs/platformData/domain/pullRequests/enums/implementationStatus.enum';
import {
    IPullRequestsRepository,
    PULL_REQUESTS_REPOSITORY_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.repository';
import type {
    ISuggestion,
    ISuggestionByPR,
} from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';

/** `implementationStatus` is undefined until `implementation-verification.processor.ts`
 *  runs — an async job fired in parallel with the review job, so it can still
 *  be unset on the very round that would benefit from it. Absent must read as
 *  "pending", never as "not implemented" — the two look identical here, but
 *  one is a race and the other is a real signal. */
export function toOutcome(
    status: ImplementationStatus | undefined,
): PrDecisionOutcome {
    switch (status) {
        case ImplementationStatus.IMPLEMENTED:
            return 'implemented';
        case ImplementationStatus.PARTIALLY_IMPLEMENTED:
            return 'partially_implemented';
        case ImplementationStatus.NOT_IMPLEMENTED:
            return 'not_implemented';
        default:
            return 'pending';
    }
}

export function toRecord(suggestion: ISuggestion): PrDecisionRecord {
    return {
        suggestionId: suggestion.id,
        relevantFile: suggestion.relevantFile,
        relevantLinesStart: suggestion.relevantLinesStart,
        relevantLinesEnd: suggestion.relevantLinesEnd,
        suggestionContent: suggestion.suggestionContent,
        label: suggestion.label,
        outcome: toOutcome(suggestion.implementationStatus),
        decidedAt: suggestion.createdAt,
    };
}

/** PR-level suggestions (`ISuggestionByPR`, stored in `prLevelSuggestions`)
 *  carry no `relevantFile` and no `implementationStatus` — the implementation
 *  check only diffs file patches, so there is no signal to derive an outcome
 *  from. Always `pending`: descriptive context ("this was already flagged"),
 *  never refutation evidence. */
export function toRecordFromPrLevel(
    suggestion: ISuggestionByPR,
): PrDecisionRecord {
    return {
        suggestionId: suggestion.id,
        suggestionContent: suggestion.suggestionContent,
        label: suggestion.label,
        outcome: 'pending',
        decidedAt: suggestion.createdAt ?? '',
    };
}

/**
 * Mongo-backed {@link PrDecisionStore}. Reads suggestions already posted
 * (`deliveryStatus: SENT`) on this exact PR — file-scoped
 * (`findSuggestionsByPRAndFilenames`) AND PR-level
 * (`findPrLevelSuggestionsByPR`, issue #1313 Fase 1b — kody-rules
 * PULL_REQUEST-scope findings live in a separate array with no file field).
 * Both are pure reads + maps, no new query shape.
 *
 * Best-effort per source, not just per request: either query can fail
 * independently (`Promise.allSettled`) without losing the other's results —
 * callers must be free to treat "no history" and "history unavailable" the
 * same way (fail open, never drop a finding over infra trouble).
 */
@Injectable()
export class PrDecisionStoreService implements PrDecisionStore {
    private readonly logger = createLogger(PrDecisionStoreService.name);

    constructor(
        @Inject(PULL_REQUESTS_REPOSITORY_TOKEN)
        private readonly pullRequestsRepository: IPullRequestsRepository,
    ) {}

    async load(
        params: LoadPrDecisionsParams,
    ): Promise<readonly PrDecisionRecord[]> {
        if (!params.filePaths.length) {
            return [];
        }

        const [fileScoped, prLevel] = await Promise.allSettled([
            this.pullRequestsRepository.findSuggestionsByPRAndFilenames(
                params.prNumber,
                params.repositoryFullName,
                params.filePaths,
                params.organizationId,
                DeliveryStatus.SENT,
            ),
            this.pullRequestsRepository.findPrLevelSuggestionsByPR(
                params.prNumber,
                params.repositoryFullName,
                params.organizationId,
                DeliveryStatus.SENT,
            ),
        ]);

        const records: PrDecisionRecord[] = [];

        if (fileScoped.status === 'fulfilled') {
            records.push(...(fileScoped.value ?? []).map(toRecord));
        } else {
            this.logFailure('file-scoped', params, fileScoped.reason);
        }

        if (prLevel.status === 'fulfilled') {
            records.push(...(prLevel.value ?? []).map(toRecordFromPrLevel));
        } else {
            this.logFailure('PR-level', params, prLevel.reason);
        }

        return records;
    }

    private logFailure(
        source: 'file-scoped' | 'PR-level',
        params: LoadPrDecisionsParams,
        error: unknown,
    ): void {
        this.logger.warn({
            message: `PrDecisionStore.load (${source}) failed; returning empty history for this source`,
            context: PrDecisionStoreService.name,
            metadata: {
                organizationId: params.organizationId,
                prNumber: params.prNumber,
                repositoryFullName: params.repositoryFullName,
            },
            error: error instanceof Error ? error : new Error(String(error)),
        });
    }
}
