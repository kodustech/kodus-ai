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

/**
 * The configs whose Forgejo integration is on `host`. None when the host is
 * unknown: a config of another instance must never take the webhook.
 */
export function forgejoConfigsOnHost<T>(
    configs: T[] | null | undefined,
    host: string | undefined,
): T[] {
    const target = normalizeHost(host);
    if (!target) {
        return [];
    }

    return (configs ?? []).filter(
        (config: any) =>
            normalizeHost(
                config?.integration?.authIntegration?.authDetails?.host,
            ) === target,
    );
}
