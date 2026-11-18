import type { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import type { PreviewOffer } from '../domain/render-runtime-comment';
import type { RunTargetWorkspaceRef } from '../domain/run-target';
import type { PublicationRetryState, PublicationScope } from '../domain/runtime-publication';
import type { PublishRepository } from '../domain/runtime-publish.ports';

// What a publication of the Runtime ends as, and what every publisher shares:
// the target the product stored for the Run, resolved and checked.

export type RefusalReason =
    | 'invalid_message'
    | 'unexpected_event'
    | 'key_mismatch'
    | 'unstructured_body'
    | 'target_not_found'
    | 'attempt_mismatch'
    | 'incomplete_record'
    | 'repository_not_in_org'
    | 'repository_mismatch'
    | 'no_integration'
    | 'platform_mismatch';

export type PublishOutcome =
    | {
          outcome: 'refused';
          reason: RefusalReason;
          runId?: string;
          key?: string;
      }
    | { outcome: 'duplicate'; key: string }
    | { outcome: 'published'; key: string; action: 'created' | 'updated' }
    | {
          outcome: 'skipped';
          key: string;
          reason: 'checks_unavailable' | 'status_permission_missing' | 'superseded_by_final' | 'stale_comment' | 'stale_check';
      };

/**
 * How a delivery is published. `fallback` is the redrive sweeper's last try
 * for a final publication the platform kept refusing: for the report comment,
 * the short notice of renderUndeliveredReportComment instead of the report,
 * so the PR comment never stays at "Writing the report"; for the completed
 * verdict check, a failed check with renderUndeliveredCheckOutput, so a
 * required check never stays open on the PR and never passes without a
 * verdict.
 */
export interface PublishOptions {
    fallback?: boolean;
}

/** Another delivery of the same key (or of the same PR comment) is publishing right now; the broker retries later. */
export class PublicationBusyError extends Error {
    constructor(readonly key: string) {
        super(`publication ${key} is being published by another delivery`);
        this.name = 'PublicationBusyError';
    }
}

/** The platform did not take the publication; the broker retries. */
export class PublicationFailedError extends Error {
    constructor(
        readonly key: string,
        reason: string,
        /** What the retry needs: a check run opened before the failure, the create-failure count. */
        readonly keep?: PublicationRetryState,
    ) {
        super(`publication ${key} failed: ${reason}`);
        this.name = 'PublicationFailedError';
    }
}

/** Where a Run publishes: the stored target, checked against the product's integration. */
export type PublishTarget = {
    scope: PublicationScope;
    organizationAndTeamData: OrganizationAndTeamData;
    repository: PublishRepository;
    platformType: PlatformType;
    /** The commits every repository of a multi-repository Run ran at, as the product stored them; absent for one repository. */
    workspace?: RunTargetWorkspaceRef[];
    /** The preview the comment and the check offer; absent: previews are off here. */
    preview?: PreviewOffer;
};

