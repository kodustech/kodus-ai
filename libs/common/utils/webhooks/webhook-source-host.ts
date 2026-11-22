import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

/**
 * Lowercased hostname of a host or URL (`https://Git.Example.com/x` and
 * `git.example.com` both give `git.example.com`), or undefined when empty.
 */
export function normalizeHost(
    value: string | undefined | null,
): string | undefined {
    if (!value) {
        return undefined;
    }
    const trimmed = String(value).trim();
    if (!trimmed) {
        return undefined;
    }
    try {
        const url = new URL(
            trimmed.includes('://') ? trimmed : `https://${trimmed}`,
        );
        return url.hostname.toLowerCase();
    } catch {
        return trimmed.toLowerCase().replace(/\/.*$/, '');
    }
}

/**
 * Host of the Forgejo instance that sent a webhook. Forgejo numbers
 * repositories per instance, so `repository.id` alone matches the
 * repositories of every connected instance that reached the same number.
 */
export function forgejoWebhookHost(payload: any): string | undefined {
    return normalizeHost(
        payload?.repository?.html_url || payload?.repository?.clone_url,
    );
}

/** The instance and the `owner/repo` a webhook comes from. */
export type WebhookSource = {
    host?: string;
    repositoryFullName?: string;
};

/** Forgejo's name for `WebhookSource`. */
export type ForgejoWebhookSource = WebhookSource;

export function forgejoWebhookSource(payload: any): WebhookSource {
    return {
        host: forgejoWebhookHost(payload),
        repositoryFullName: payload?.repository?.full_name,
    };
}

/**
 * Host of the GitLab instance that sent a webhook, and the project's
 * `group/project`. GitLab numbers projects per instance, so `project.id`
 * alone matches the projects of every connected instance that reached the
 * same number.
 */
export function gitlabWebhookSource(payload: any): WebhookSource {
    const sources = [
        payload?.project?.git_http_url,
        payload?.project?.web_url,
        payload?.project?.url,
        payload?.repository?.url,
        payload?.repository?.homepage,
    ];
    let host: string | undefined;
    for (const source of sources) {
        if (typeof source !== 'string' || !source) continue;
        try {
            host = new URL(source).hostname.toLowerCase();
            break;
        } catch {
            continue;
        }
    }
    return {
        host,
        repositoryFullName: payload?.project?.path_with_namespace,
    };
}

/**
 * Platforms whose repository ids are numbered per instance, so the same id
 * names unrelated repositories on two servers. Their webhooks are resolved
 * on the instance that sent them; elsewhere an id names one repository.
 */
const PER_INSTANCE_REPOSITORY_IDS = new Set<PlatformType | string>([
    PlatformType.GITLAB,
    PlatformType.FORGEJO,
]);

/**
 * The configs that may take a webhook: on GitLab and Forgejo, only those on
 * the instance that sent it (`instanceConfigsForWebhook`); on the other
 * platforms, every config of the repository id.
 */
export function webhookConfigsOfInstance<T>(
    platformType: PlatformType | string,
    configs: T[] | null | undefined,
    source: WebhookSource & { repositoryId?: string | number },
): T[] {
    return PER_INSTANCE_REPOSITORY_IDS.has(platformType)
        ? instanceConfigsForWebhook(configs, source)
        : (configs ?? []);
}

/**
 * The configs that hold the repository a webhook comes from, on a platform
 * that numbers repositories per instance. A config on the sending host takes
 * it: the host of the repository it lists under that id, or of its
 * integration. Renaming or moving the repository keeps the host. When none
 * is on that host, a config that keeps the same `owner/repo` under that id
 * takes it: Kodus may reach the instance at another address than the one
 * the instance builds its URLs from, such as a docker service name or an
 * IP. None otherwise: a config of another instance must never take the
 * webhook, even when it is the only one with that id. Only configs that
 * store no host at all, with none of the candidates on a known instance,
 * keep taking it as before.
 */
export function instanceConfigsForWebhook<T>(
    configs: T[] | null | undefined,
    source: WebhookSource & { repositoryId?: string | number },
): T[] {
    const candidates = configs ?? [];
    const repositoryId = String(source?.repositoryId ?? '');

    const host = normalizeHost(source?.host);
    const onHost = host
        ? candidates.filter((config) =>
              configHostsOf(config, repositoryId).includes(host),
          )
        : [];
    if (onHost.length) {
        return onHost;
    }

    const fullName = normalizeFullName(source?.repositoryFullName);
    const sameRepository =
        fullName && repositoryId
            ? candidates.filter((config) => {
                  const listed = listedRepositoryOf(config, repositoryId);
                  return (
                      !!listed &&
                      normalizeFullName(
                          listed?.fullName ?? listed?.full_name ?? listed?.name,
                      ) === fullName
                  );
              })
            : [];
    if (sameRepository.length) {
        return sameRepository;
    }

    // Data written before configs stored any host: when no candidate's
    // instance is known, nothing tells them apart, as before. One known
    // instance is enough to refuse the others.
    const noneKnown =
        candidates.length > 0 &&
        candidates.every(
            (config) => configHostsOf(config, repositoryId).length === 0,
        );
    return noneKnown ? candidates : [];
}

/** Forgejo's name for `instanceConfigsForWebhook`. */
export const forgejoConfigsForWebhook = instanceConfigsForWebhook;

/** The hosts a config is known to be on, for the repository `repositoryId`. */
function configHostsOf(config: any, repositoryId: string): string[] {
    const listed = listedRepositoryOf(config, repositoryId);
    return [
        normalizeHost(listed?.http_url ?? listed?.web_url ?? listed?.url),
        normalizeHost(storedHostOf(config)),
    ].filter((host): host is string => !!host);
}

function listedRepositoryOf(config: any, repositoryId: string): any {
    if (!repositoryId) return undefined;
    return (Array.isArray(config?.configValue) ? config.configValue : []).find(
        (repository: any) => String(repository?.id) === repositoryId,
    );
}

/** The instance host stored on a config's integration. */
export function storedHostOf(config: any): string | undefined {
    return config?.integration?.authIntegration?.authDetails?.host;
}

function normalizeFullName(
    value: string | undefined | null,
): string | undefined {
    const trimmed = String(value ?? '')
        .trim()
        .toLowerCase();
    return trimmed || undefined;
}
