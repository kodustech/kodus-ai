import type { ContextDependency, ContextPack } from '@libs/ai-engine/infrastructure/adapters/services/context/context-pack';
import { PromptSourceType } from '@libs/ai-engine/domain/prompt/interfaces/promptExternalReference.interface';

export interface ContextMarkerPattern {
    name: string;
    regex: RegExp;
    toDependency(match: RegExpMatchArray): ContextDependency | null;
}

const GLOBAL_REGEX_FLAGS = (regex: RegExp): string =>
    regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;

export const CODE_REVIEW_CONTEXT_PATTERNS: ContextMarkerPattern[] = [
    {
        name: 'mcp',
        regex: /@mcp<([^|>]+)\|([^>]+)>/gi,
        toDependency: (match) => {
            if (!match[1] || !match[2]) {
                return null;
            }
            const provider = match[1].trim();
            const tool = match[2].trim();

            if (!provider || !tool) {
                return null;
            }

            return {
                type: 'mcp',
                id: `${provider}|${tool}`,
                metadata: {
                    marker: match[0],
                    provider,
                    tool,
                },
            };
        },
    },
];

const PATH_SOURCE_TYPE_MAP: Record<string, PromptSourceType> = {
    'summary.customInstructions': PromptSourceType.CUSTOM_INSTRUCTION,
    'v2PromptOverrides.categories.descriptions.bug':
        PromptSourceType.CATEGORY_BUG,
    'v2PromptOverrides.categories.descriptions.performance':
        PromptSourceType.CATEGORY_PERFORMANCE,
    'v2PromptOverrides.categories.descriptions.security':
        PromptSourceType.CATEGORY_SECURITY,
    'v2PromptOverrides.severity.flags.critical':
        PromptSourceType.SEVERITY_CRITICAL,
    'v2PromptOverrides.severity.flags.high': PromptSourceType.SEVERITY_HIGH,
    'v2PromptOverrides.severity.flags.medium': PromptSourceType.SEVERITY_MEDIUM,
    'v2PromptOverrides.severity.flags.low': PromptSourceType.SEVERITY_LOW,
    'v2PromptOverrides.generation.main': PromptSourceType.GENERATION_MAIN,
};

function mergeDependencyMaps(
    target: Map<string, ContextDependency>,
    source: ContextDependency[],
) {
    for (const dependency of source) {
        const key = `${dependency.type}:${dependency.id}`;

        if (target.has(key)) {
            const existing = target.get(key)!;
            target.set(key, {
                ...existing,
                ...dependency,
                metadata: {
                    ...(existing.metadata ?? {}),
                    ...(dependency.metadata ?? {}),
                },
            });
        } else {
            target.set(key, dependency);
        }
    }
}

export function extractDependenciesFromText(
    text: string,
    patterns: ContextMarkerPattern[],
): { dependencies: ContextDependency[]; markers: string[] } {
    const dependencyMap = new Map<string, ContextDependency>();
    const markers = new Set<string>();

    for (const pattern of patterns) {
        const regex = new RegExp(
            pattern.regex.source,
            GLOBAL_REGEX_FLAGS(pattern.regex),
        );
        let match: RegExpExecArray | null;

        while ((match = regex.exec(text)) !== null) {
            const dependency = pattern.toDependency(match);
            if (!dependency) {
                continue;
            }
            const key = `${dependency.type}:${dependency.id}`;
            if (!dependencyMap.has(key)) {
                dependencyMap.set(key, dependency);
            }
            markers.add(match[0]);
        }
    }

    return {
        dependencies: Array.from(dependencyMap.values()),
        markers: Array.from(markers.values()),
    };
}

export function extractDependenciesFromRichText(
    rawValue: string,
    patterns: ContextMarkerPattern[],
): { dependencies: ContextDependency[]; markers: string[] } {
    const dependenciesMap = new Map<string, ContextDependency>();
    const markers = new Set<string>();

    let parsed: unknown;
    try {
        parsed = JSON.parse(rawValue);
    } catch {
        parsed = undefined;
    }

    if (!parsed || typeof parsed !== 'object') {
        return extractDependenciesFromText(rawValue, patterns);
    }

    const visit = (node: unknown) => {
        if (!node || typeof node !== 'object') {
            return;
        }

        const candidate = node as Record<string, unknown>;
        const type = candidate.type as string | undefined;

        if (type === 'mcpMention') {
            const attrs = candidate.attrs as
                | Record<string, unknown>
                | undefined;
            const provider =
                typeof attrs?.app === 'string' ? attrs.app : undefined;
            const toolName =
                typeof attrs?.tool === 'string' ? attrs.tool : undefined;
            if (provider && toolName) {
                const dependency: ContextDependency = {
                    type: 'mcp',
                    id: `${provider}|${toolName}`,
                    metadata: {
                        provider,
                        toolName,
                        marker: `@mcp<${provider}|${toolName}>`,
                    },
                };
                mergeDependencyMaps(dependenciesMap, [dependency]);
                markers.add(`@mcp<${provider}|${toolName}>`);
            }
        }

        if (typeof candidate.text === 'string') {
            const { dependencies, markers: textMarkers } =
                extractDependenciesFromText(candidate.text, patterns);
            mergeDependencyMaps(dependenciesMap, dependencies);
            textMarkers.forEach((marker) => markers.add(marker));
        }

        if (Array.isArray(candidate.content)) {
            candidate.content.forEach(visit);
        }

        for (const value of Object.values(candidate)) {
            if (Array.isArray(value)) {
                value.forEach(visit);
            } else if (value && typeof value === 'object') {
                visit(value);
            }
        }
    };

    visit(parsed);

    return {
        dependencies: Array.from(dependenciesMap.values()),
        markers: Array.from(markers.values()),
    };
}

export function extractDependenciesFromValue(
    rawValue: string,
    patterns: ContextMarkerPattern[],
): { dependencies: ContextDependency[]; markers: string[] } {
    if (!rawValue) {
        return { dependencies: [], markers: [] };
    }

    const trimmed = rawValue.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return extractDependenciesFromRichText(trimmed, patterns);
    }

    return extractDependenciesFromText(rawValue, patterns);
}

export function stripMarkersFromText(
    text: string,
    patterns: ContextMarkerPattern[],
): string {
    let sanitized = text;
    for (const pattern of patterns) {
        const regex = new RegExp(
            pattern.regex.source,
            GLOBAL_REGEX_FLAGS(pattern.regex),
        );
        sanitized = sanitized.replace(regex, '');
    }

    // Collapse multiple spaces while preserving newlines
    sanitized = sanitized.replace(/[ \t]{2,}/g, ' ');
    sanitized = sanitized.replace(/\n{3,}/g, '\n\n');

    return sanitized.trim();
}

export function pathToKey(path: string[]): string {
    return path.join('.');
}

export function resolveSourceTypeFromPath(
    path: string[],
): PromptSourceType | undefined {
    if (!path.length) {
        return undefined;
    }
    const key = pathToKey(path);
    return PATH_SOURCE_TYPE_MAP[key];
}

export function tryParseJSON(str: unknown): unknown | null {
    if (!str || typeof str !== 'string') {
        return null;
    }

    const trimmed = str.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return null;
    }

    try {
        return JSON.parse(str);
    } catch {
        return null;
    }
}

export function normalizeProviderToolKey(
    provider: string,
    tool: string,
): string {
    return `${provider.toLowerCase().trim()}|${tool.toLowerCase().trim()}`;
}

export function resolveDependencyProvider(
    dependency: ContextDependency,
): string | undefined {
    const metadata = dependency.metadata ?? {};
    if (typeof metadata.provider === 'string') {
        return metadata.provider as string;
    }
    if (typeof metadata.mcpId === 'string') {
        return metadata.mcpId as string;
    }
    const [provider] = dependency.id.split('|', 2);
    return provider || undefined;
}

export function resolveDependencyToolName(
    dependency: ContextDependency,
): string | undefined {
    const metadata = dependency.metadata ?? {};
    if (typeof metadata.toolName === 'string') {
        return metadata.toolName as string;
    }
    if (typeof metadata.tool === 'string') {
        return metadata.tool as string;
    }
    const [, toolName] = dependency.id.split('|', 2);
    return toolName || undefined;
}

export function deepClone<T>(value: T): T {
    if (value === null || value === undefined) {
        return value;
    }

    try {
        return JSON.parse(JSON.stringify(value)) as T;
    } catch {
        return value;
    }
}

export function getOverridesFromPack<T = any>(
    pack?: ContextPack,
): T | undefined {
    if (!pack) {
        return undefined;
    }
    const layer = pack.layers.find(
        (l) => l.metadata?.sourceType === 'instructions',
    );
    return layer?.content as T;
}

export function getAugmentationsFromPack<T = any>(
    pack?: ContextPack,
): T | undefined {
    if (!pack) {
        return undefined;
    }
    const layer = pack.layers.find(
        (l) => l.metadata?.sourceType === 'augmentations',
    );
    return layer?.content as T;
}
