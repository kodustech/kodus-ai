export function normalizeProviderKey(
    value?: string | null,
): string | undefined {
    if (!value) {
        return undefined;
    }

    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');

    if (!normalized) {
        return undefined;
    }

    return normalized.endsWith('mcp') && normalized.length > 3
        ? normalized.slice(0, -3)
        : normalized;
}

export function normalizeToolKey(value?: string | null): string | undefined {
    if (!value) {
        return undefined;
    }

    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');

    return normalized || undefined;
}

export function registerProviderAliases(
    aliasMap: Map<string, string>,
    canonicalProvider: string,
    aliases: Array<string | undefined>,
): void {
    const trimmedCanonical = canonicalProvider?.trim();
    if (!trimmedCanonical) {
        return;
    }

    if (!aliasMap.has(trimmedCanonical)) {
        aliasMap.set(trimmedCanonical, trimmedCanonical);
    }

    const normalizedCanonical = normalizeProviderKey(trimmedCanonical);
    if (normalizedCanonical && !aliasMap.has(normalizedCanonical)) {
        aliasMap.set(normalizedCanonical, trimmedCanonical);
    }

    for (const candidate of aliases) {
        const trimmed = candidate?.trim();
        if (!trimmed) {
            continue;
        }

        if (!aliasMap.has(trimmed)) {
            aliasMap.set(trimmed, trimmedCanonical);
        }

        const normalized = normalizeProviderKey(trimmed);
        if (normalized && !aliasMap.has(normalized)) {
            aliasMap.set(normalized, trimmedCanonical);
        }
    }
}

export function registerToolAliases(
    toolAliases: Map<string, Map<string, string>>,
    canonicalProvider: string,
    toolName: string,
): void {
    const trimmedProvider = canonicalProvider?.trim();
    const trimmedTool = toolName?.trim();

    if (!trimmedProvider || !trimmedTool) {
        return;
    }

    const providerKey =
        normalizeProviderKey(trimmedProvider) ?? trimmedProvider;
    if (!toolAliases.has(providerKey)) {
        toolAliases.set(providerKey, new Map());
    }

    const aliasMap = toolAliases.get(providerKey)!;
    const variants = new Set<string>([
        trimmedTool,
        trimmedTool.toLowerCase(),
        trimmedTool.toUpperCase(),
    ]);

    const normalizedTool = normalizeToolKey(trimmedTool);
    if (normalizedTool) {
        variants.add(normalizedTool);
    }

    for (const alias of variants) {
        if (!aliasMap.has(alias)) {
            aliasMap.set(alias, trimmedTool);
        }
    }
}

export function resolveCanonicalProvider(
    aliasMap: Map<string, string>,
    provider?: string,
): string | undefined {
    if (!provider) {
        return undefined;
    }

    const trimmed = provider.trim();
    if (!trimmed) {
        return undefined;
    }

    const direct = aliasMap.get(trimmed);
    if (direct) {
        return direct;
    }

    const normalized = normalizeProviderKey(trimmed);
    if (normalized) {
        const resolved = aliasMap.get(normalized);
        if (resolved) {
            return resolved;
        }
    }

    return trimmed;
}

export function resolveCanonicalTool(
    toolAliases: Map<string, Map<string, string>>,
    providerAliases: Map<string, string>,
    provider: string,
    toolName?: string,
): string | undefined {
    if (!toolName) {
        return undefined;
    }

    const canonicalProvider =
        resolveCanonicalProvider(providerAliases, provider) ?? provider;
    const providerKey =
        normalizeProviderKey(canonicalProvider) ?? canonicalProvider;
    const aliasMap = toolAliases.get(providerKey);

    if (!aliasMap) {
        return toolName;
    }

    const trimmedTool = toolName.trim();
    if (!trimmedTool) {
        return undefined;
    }

    const direct = aliasMap.get(trimmedTool);
    if (direct) {
        return direct;
    }

    const lower = aliasMap.get(trimmedTool.toLowerCase());
    if (lower) {
        return lower;
    }

    const upper = aliasMap.get(trimmedTool.toUpperCase());
    if (upper) {
        return upper;
    }

    const normalized = normalizeToolKey(trimmedTool);
    if (normalized) {
        const resolved = aliasMap.get(normalized);
        if (resolved) {
            return resolved;
        }
    }

    return trimmedTool;
}

export function markProviderHasMetadata(
    providersWithMetadata: Set<string>,
    provider: string,
): void {
    const trimmed = provider?.trim();
    if (!trimmed) {
        return;
    }

    providersWithMetadata.add(trimmed);

    const normalized = normalizeProviderKey(trimmed);
    if (normalized) {
        providersWithMetadata.add(normalized);
    }
}
