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

/** The instance and the `owner/repo` a Forgejo webhook comes from. */
export type ForgejoWebhookSource = {
    host?: string;
    repositoryFullName?: string;
};

export function forgejoWebhookSource(payload: any): ForgejoWebhookSource {
    return {
        host: forgejoWebhookHost(payload),
        repositoryFullName: payload?.repository?.full_name,
    };
}

/**
 * The configs that hold the repository a Forgejo webhook comes from. A
 * config on the sending host takes it; renaming or moving the repository
 * keeps the host. When none is on that host, a config that keeps the same
 * `owner/repo` under that id takes it: Kodus may reach the instance at
 * another address than the one Forgejo builds its URLs from (`ROOT_URL`),
 * such as a docker service name or an IP. None otherwise: a config of
 * another instance must never take the webhook.
 */
export function forgejoConfigsForWebhook<T>(
    configs: T[] | null | undefined,
    source: ForgejoWebhookSource & { repositoryId?: string | number },
): T[] {
    const candidates = configs ?? [];

    const host = normalizeHost(source?.host);
    const onHost = host
        ? candidates.filter(
              (config) => normalizeHost(storedHostOf(config)) === host,
          )
        : [];
    if (onHost.length) {
        return onHost;
    }

    const fullName = normalizeFullName(source?.repositoryFullName);
    const repositoryId = String(source?.repositoryId ?? '');
    if (!fullName || !repositoryId) {
        return [];
    }

    return candidates.filter((config: any) =>
        (Array.isArray(config?.configValue) ? config.configValue : []).some(
            (repository: any) =>
                String(repository?.id) === repositoryId &&
                normalizeFullName(repository?.fullName ?? repository?.name) ===
                    fullName,
        ),
    );
}

/** The instance host stored on a config's Forgejo integration. */
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
