import { createHash } from 'crypto';

import { decrypt } from '@libs/common/utils/crypto';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';

export type RepositorySelectionMode = 'manual' | 'all';

/** What the admin chose. Stored as `IntegrationConfigKey.REPOSITORY_SELECTION`. */
export interface RepositorySelectionConfig {
    mode: RepositorySelectionMode;
    includeForksAndMirrors?: boolean;
    updatedAt?: string;
    updatedBy?: string;
}

export type RepositorySyncStatus = 'running' | 'done' | 'failed' | 'rate_limited';

/**
 * Where the sync stands for one team, plus the work it still owes. Stored as
 * `IntegrationConfigKey.REPOSITORY_SYNC_STATE`, apart from the selection, so a
 * sync writing its progress can never overwrite what the admin chose.
 */
export interface RepositorySyncState {
    status: RepositorySyncStatus;
    trigger?: RepositorySyncTrigger;
    startedAt: string;
    finishedAt?: string;
    lastSuccessAt?: string;
    /** Repositories the credential can see. */
    visible?: number;
    skipped?: { archived: number; forksAndMirrors: number };
    /** Repositories this run sets up (new ones plus pending webhooks). */
    total?: number;
    done?: number;
    added?: number;
    error?: string;
    /** Added repositories whose AST build has not been enqueued yet. */
    pendingAstRepositoryIds?: string[];
    /** Added repositories whose history backfill has not started yet. */
    pendingBackfillRepositoryIds?: string[];
}

export type RepositorySyncTrigger = 'enable' | 'cron' | 'provider_event';

export interface DiscoveryFilterResult {
    eligible: Repositories[];
    skipped: { archived: number; forksAndMirrors: number };
}

export function filterDiscoveredRepositories(
    repositories: Repositories[],
    selection: Pick<RepositorySelectionConfig, 'includeForksAndMirrors'>,
): DiscoveryFilterResult {
    const skipped = { archived: 0, forksAndMirrors: 0 };
    const eligible: Repositories[] = [];

    for (const repository of repositories ?? []) {
        if (repository?.archived) {
            skipped.archived += 1;
            continue;
        }
        if (
            !selection.includeForksAndMirrors &&
            (repository?.fork || repository?.mirror)
        ) {
            skipped.forksAndMirrors += 1;
            continue;
        }
        eligible.push(repository);
    }

    return { eligible, skipped };
}

const SECRET_FIELDS = [
    'authToken',
    'accessToken',
    'token',
    'appPassword',
] as const;

function tryDecrypt(value: unknown): string {
    if (typeof value !== 'string' || !value) {
        return '';
    }
    try {
        return decrypt(value) || value;
    } catch {
        return value;
    }
}

/**
 * Identifies the credential behind a team's integration, so teams that share
 * one see one listing per sync instead of each repeating the provider calls.
 * Secrets are decrypted only to hash them; stored ciphertexts differ for the
 * same token saved twice. Null when the credential cannot be identified.
 */
export function credentialFingerprint(
    platform: PlatformType | string,
    authDetails: Record<string, unknown> | null | undefined,
): string | null {
    if (!authDetails) {
        return null;
    }

    const identity: Record<string, string> = {
        platform: String(platform),
        host: String(authDetails.host ?? authDetails.orgUrl ?? ''),
        account: String(
            authDetails.org ?? authDetails.orgName ?? authDetails.username ?? '',
        ),
    };

    if (authDetails.installationId) {
        identity.installationId = String(authDetails.installationId);
    } else {
        const secret = SECRET_FIELDS.map((field) =>
            tryDecrypt(authDetails[field]),
        ).find(Boolean);

        if (!secret) {
            return null;
        }
        identity.secret = secret;
    }

    return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
