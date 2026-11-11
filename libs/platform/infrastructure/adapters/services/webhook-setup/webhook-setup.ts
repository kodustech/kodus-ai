import {
    is429Error,
    retryAfterMsFromError,
} from '@libs/core/infrastructure/http/rate-limit-retry';
import {
    WebhookSetupFailure,
    WebhookSetupResult,
} from '@libs/platform/domain/platformIntegrations/types/codeManagement/webhook-setup.type';

export type {
    WebhookSetupFailure,
    WebhookSetupFailureKind,
    WebhookSetupResult,
} from '@libs/platform/domain/platformIntegrations/types/codeManagement/webhook-setup.type';

export interface WebhookSetupLabels {
    /** Provider name as the admin reads it, e.g. "GitLab". */
    provider: string;
    /** What the credential needs, appended to permission errors. */
    permissionHint?: string;
}

type RepositoryRef = { id: string | number };

function httpStatusOf(error: unknown): number | undefined {
    const err = error as {
        status?: unknown;
        statusCode?: unknown;
        response?: { status?: unknown; statusCode?: unknown };
        cause?: { response?: { status?: unknown } };
    };

    const candidates = [
        err?.response?.status,
        err?.response?.statusCode,
        err?.status,
        err?.statusCode,
        err?.cause?.response?.status,
    ];

    for (const candidate of candidates) {
        const status = Number(candidate);
        if (Number.isInteger(status) && status >= 100 && status < 600) {
            return status;
        }
    }

    return undefined;
}

export function classifyWebhookSetupError(
    error: unknown,
    labels: WebhookSetupLabels,
): WebhookSetupFailure {
    const status = httpStatusOf(error);
    const message =
        (error as { message?: unknown })?.message &&
        typeof (error as { message?: unknown }).message === 'string'
            ? (error as { message: string }).message
            : undefined;

    const head = status
        ? `${labels.provider} refused the webhook (HTTP ${status})`
        : `${labels.provider} refused the webhook`;
    const detail = message ? `: ${message}` : '';

    if (status === 429 || is429Error(error)) {
        const retryAfterMs = retryAfterMsFromError(error) ?? undefined;
        return {
            kind: 'rate_limited',
            reason: `${head}${detail}. The provider is rate limiting requests; it will be retried on the next sync.`,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        };
    }

    if (status === 401 || status === 403) {
        const hint = labels.permissionHint ? ` ${labels.permissionHint}` : '';
        return {
            kind: 'permission',
            reason: `${head}${detail}.${hint}`,
        };
    }

    return { kind: 'error', reason: `${head}${detail}.` };
}

/**
 * Runs `perRepository` for each repository, one at a time. A failure on one
 * repository is recorded and the next one runs; a rate limit stops the run,
 * since every further call would be refused too.
 */
export async function runWebhookSetup<T extends RepositoryRef>(
    repositories: T[],
    perRepository: (repository: T) => Promise<void>,
    labels: WebhookSetupLabels,
): Promise<WebhookSetupResult> {
    const result: WebhookSetupResult = {
        configured: [],
        failed: {},
        notAttempted: [],
    };

    for (let index = 0; index < repositories.length; index += 1) {
        const repository = repositories[index];
        const id = String(repository.id);

        try {
            await perRepository(repository);
            result.configured.push(id);
        } catch (error) {
            const failure = classifyWebhookSetupError(error, labels);
            result.failed[id] = failure;

            if (failure.kind === 'rate_limited') {
                result.rateLimited =
                    failure.retryAfterMs !== undefined
                        ? { retryAfterMs: failure.retryAfterMs }
                        : {};
                result.notAttempted = repositories
                    .slice(index + 1)
                    .map((r) => String(r.id));
                break;
            }
        }
    }

    return result;
}

/** One failure for every repository, for an error before any of them ran. */
export function failWebhookSetupForAll<T extends RepositoryRef>(
    repositories: T[],
    error: unknown,
    labels: WebhookSetupLabels,
): WebhookSetupResult {
    const failure = classifyWebhookSetupError(error, labels);
    const failed: Record<string, WebhookSetupFailure> = {};

    for (const repository of repositories) {
        failed[String(repository.id)] = failure;
    }

    return {
        configured: [],
        failed,
        notAttempted: [],
        ...(failure.kind === 'rate_limited'
            ? {
                  rateLimited:
                      failure.retryAfterMs !== undefined
                          ? { retryAfterMs: failure.retryAfterMs }
                          : {},
              }
            : {}),
    };
}
