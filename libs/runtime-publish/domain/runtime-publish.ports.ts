import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import type { IChecksAdapter } from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';

// What the publisher needs from the product. The implementations are the
// product's own services (CodeManagementService, ChecksAdapterFactory, the
// integration config); the use case sees only these shapes.

export const RUNTIME_PUBLICATION_STORE_TOKEN = Symbol.for(
    'RuntimePublicationStore',
);
export const RUNTIME_PUBLISH_REPOSITORY_RESOLVER_TOKEN = Symbol.for(
    'RuntimePublishRepositoryResolver',
);
export const RUNTIME_PUBLISH_CODE_MANAGEMENT_TOKEN = Symbol.for(
    'RuntimePublishCodeManagement',
);
export const RUNTIME_PUBLISH_CHECKS_TOKEN = Symbol.for('RuntimePublishChecks');
export const RUNTIME_PUBLISH_SUGGESTION_RESOLVER_TOKEN = Symbol.for(
    'RuntimePublishSuggestionResolver',
);
export const RUNTIME_PUBLISH_METRICS_TOKEN = Symbol.for('RuntimePublishMetrics');
/** Base URL of the Kodus dashboard (API_FRONTEND_URL), for the links in the comment. */
export const RUNTIME_PUBLISH_DASHBOARD_URL_TOKEN = Symbol.for(
    'RuntimePublishDashboardUrl',
);

/**
 * How long a comment delivery waits for the PR's comment slot before it gives
 * the delivery back to the broker. Phases of one Run arrive a second apart and
 * a slot is held for one edit, so a short wait settles nearly every race here.
 */
export const RUNTIME_PUBLISH_SLOT_WAIT_TOKEN = Symbol.for(
    'RuntimePublishSlotWait',
);

export interface CommentSlotWait {
    maxWaitMs: number;
    sleep?: (ms: number) => Promise<void>;
}

/** Name of the check run on the PR head. */
export const KODY_RUNTIME_CHECK_NAME = 'Kody Runtime';

/** A repository as the product's integration config knows it. */
export interface PublishRepository {
    id: string;
    name: string;
    owner: string;
    fullName: string;
}

export interface RepositoryResolver {
    /**
     * The repository `repositoryId` among the ones configured for this org
     * and team, or null when it is not one of them.
     */
    resolve(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId: string,
    ): Promise<PublishRepository | null>;
}

interface CommentTarget {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: { name: string; id: string };
    prNumber: number;
    body: string;
}

/** The slice of CodeManagementService the publisher uses. */
export interface CodeManagementPort {
    getTypeIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PlatformType>;
    createIssueComment(
        params: CommentTarget,
        type?: PlatformType,
    ): Promise<any>;
    /** A reply in the thread of a review comment (GitHub). */
    createResponseToComment(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { name: string; id: string };
            prNumber: number;
            inReplyToId: number;
            body: string;
        },
        type?: PlatformType,
    ): Promise<any>;
    /** Every comment of the PR; `failOnError` so a platform error is not read as "no comment". */
    getAllCommentsInPullRequest(
        params: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { name: string; id: string };
            prNumber: number;
            failOnError: true;
        },
        type?: PlatformType,
    ): Promise<any[]>;
    /** Throws the platform error (with its HTTP `status`) when the edit fails. */
    updateIssueComment(
        params: CommentTarget & {
            commentId: number;
            noteId?: number;
            threadId?: number;
        },
        type?: PlatformType,
    ): Promise<any>;
}

/** The slice of ChecksAdapterFactory the publisher uses. */
export interface ChecksPort {
    getAdapter(platformType: PlatformType): IChecksAdapter;
}

/**
 * A review suggestion of this PR, by its product id. The Runtime names the
 * suggestion; the platform comment it replies to comes only from the
 * product's own record of the review, for the stored org, repo and PR.
 */
export interface SuggestionResolver {
    resolve(input: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        prNumber: number;
        suggestionId: string;
    }): Promise<{ commentId: number } | null>;
}

/** What one delivery ended as, for the publish metrics. */
export interface PublishMeasurement {
    kind: string;
    /** published, duplicate, skipped, refused, or retry (the delivery threw and the broker redelivers). */
    outcome: string;
    reason?: string;
    durationMs: number;
}

export interface PublishMetrics {
    record(measurement: PublishMeasurement): void;
}

/** What the redrive sweeper did with one stale publication (publication-redrive.ts). */
export interface RedriveMeasurement {
    kind: string;
    /** redrive (the stored request again), fallback (the short notice), give_up. */
    step: 'redrive' | 'fallback' | 'give_up';
    /** recovered (it landed, or was already done), retry_later, gave_up. */
    outcome: 'recovered' | 'retry_later' | 'gave_up';
}

export interface RedriveMetrics {
    recordRedrive(measurement: RedriveMeasurement): void;
    /** Final publications found stale by the last sweep: failed or with an expired lease past the threshold. */
    recordStuck(count: number): void;
}

/** Platforms with a checks API; elsewhere the comment carries the result. */
export const CHECKS_PLATFORMS: ReadonlySet<PlatformType> = new Set([
    PlatformType.GITHUB,
    PlatformType.FORGEJO,
]);
