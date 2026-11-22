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
    const sshHost = sshRemoteHost(trimmed);
    if (sshHost) {
        return sshHost;
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

/** The host of an SSH remote such as `git@host:group/repo.git`. */
function sshRemoteHost(value: string): string | undefined {
    return /^[^@/\s]+@([^:/\s]+):/.exec(value.trim())?.[1]?.toLowerCase();
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
            host =
                sshRemoteHost(source) ?? new URL(source).hostname.toLowerCase();
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
 * integration. Renaming or moving the repository keeps the host. A config
 * whose listed repository URL is on another host is on another instance,
 * since the instance builds that URL, and never takes it, even when it is
 * the only one with that id. Its integration host alone does not tell:
 * Kodus may reach the instance at another address, such as a docker service
 * name or an IP. Among the configs that list no repository URL, one that
 * keeps the same `owner/repo` under that id takes it, and otherwise those
 * that store no host at all, as before.
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

    const unlisted = candidates.filter(
        (config) => !listedHostOf(config, repositoryId),
    );

    const fullName = normalizeFullName(source?.repositoryFullName);
    const sameRepository =
        fullName && repositoryId
            ? unlisted.filter((config) => {
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

    // Data written before configs stored any host: nothing tells them
    // apart, as before.
    return unlisted.filter(
        (config) => configHostsOf(config, repositoryId).length === 0,
    );
}

/** Forgejo's name for `instanceConfigsForWebhook`. */
export const forgejoConfigsForWebhook = instanceConfigsForWebhook;

/** The hosts a config is known to be on, for the repository `repositoryId`. */
function configHostsOf(config: any, repositoryId: string): string[] {
    return [
        listedHostOf(config, repositoryId),
        normalizeHost(storedHostOf(config)),
    ].filter((host): host is string => !!host);
}

/** The host of the repository URL a config lists under that id. */
function listedHostOf(config: any, repositoryId: string): string | undefined {
    const listed = listedRepositoryOf(config, repositoryId);
    return normalizeHost(listed?.http_url ?? listed?.web_url ?? listed?.url);
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
