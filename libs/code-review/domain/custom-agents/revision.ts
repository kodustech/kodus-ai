import { createHash } from 'crypto';

import type { CustomAgentConfigLevel } from './cli-secrets';

/**
 * The two lists the custom agents screens write whole. Each is saved as one
 * array at a config level, so a save made from a stale copy would silently
 * drop what someone else saved in between.
 */
export const CUSTOM_AGENTS_FIELDS = ['customAgents', 'knowledge'] as const;
export type CustomAgentsField = (typeof CUSTOM_AGENTS_FIELDS)[number];

/** A fingerprint of each list as a config level resolves it. */
export type CustomAgentsRevisions = Record<CustomAgentsField, string>;

/** The fingerprints the screen loaded, sent back with its save. */
export type ExpectedCustomAgentsRevisions = Partial<CustomAgentsRevisions>;

export const STALE_CUSTOM_AGENTS_MESSAGE =
    'Someone else changed these agents since you opened them. Reload to see their changes, then apply yours again.';

export class StaleCustomAgentsError extends Error {
    constructor(readonly fields: CustomAgentsField[]) {
        super(STALE_CUSTOM_AGENTS_MESSAGE);
        this.name = 'StaleCustomAgentsError';
    }
}

type ConfigsLike = Record<string, unknown> | undefined;
type DirectoryLike = {
    id?: string;
    folders?: Array<{ path?: string }>;
    configs?: ConfigsLike;
};
type RepositoryLike = {
    id?: string;
    configs?: ConfigsLike;
    directories?: DirectoryLike[];
};
type CodeReviewConfigValueLike = {
    configs?: ConfigsLike;
    repositories?: RepositoryLike[];
};

const findDirectory = (
    repository: RepositoryLike | undefined,
    level: CustomAgentConfigLevel,
): DirectoryLike | undefined => {
    if (!repository) return undefined;
    if (level.directoryId) {
        return repository.directories?.find(
            (dir) => dir?.id === level.directoryId,
        );
    }
    const paths = level.directoryPaths?.filter(Boolean) ?? [];
    if (paths.length === 0) return undefined;
    return repository.directories?.find((dir) => {
        const folders = (dir?.folders ?? []).map((f) => f?.path);
        return (
            folders.length === paths.length &&
            paths.every((path) => folders.includes(path))
        );
    });
};

/**
 * The list a level resolves to: the most specific level that stores the
 * field (directory, then repository, then global) wins, as a list there
 * replaces its parent's.
 */
const effectiveList = (
    configValue: CodeReviewConfigValueLike | undefined,
    level: CustomAgentConfigLevel,
    field: CustomAgentsField,
): unknown[] | null => {
    const repositoryId =
        level.repositoryId && level.repositoryId !== 'global'
            ? level.repositoryId
            : undefined;
    const repository = repositoryId
        ? configValue?.repositories?.find((repo) => repo?.id === repositoryId)
        : undefined;
    const directory = findDirectory(repository, level);

    for (const configs of [
        directory?.configs,
        repository?.configs,
        configValue?.configs,
    ]) {
        const list = configs?.[field];
        if (Array.isArray(list)) return list;
    }
    return null;
};

const stableStringify = (value: unknown): string =>
    JSON.stringify(value, (_key, v) =>
        v && typeof v === 'object' && !Array.isArray(v)
            ? Object.fromEntries(
                  Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
              )
            : v,
    );

const fingerprint = (value: unknown): string =>
    createHash('sha256')
        .update(stableStringify(value))
        .digest('hex')
        .slice(0, 32);

/**
 * Fingerprints of the stored custom agents and knowledge a level resolves
 * to. Computed from the stored config (CLI secrets still sealed), so a
 * secret typed again also counts as a change.
 */
export function customAgentsRevisionsAtLevel(
    configValue: CodeReviewConfigValueLike | undefined,
    level: CustomAgentConfigLevel,
): CustomAgentsRevisions {
    return {
        customAgents: fingerprint(
            effectiveList(configValue, level, 'customAgents'),
        ),
        knowledge: fingerprint(effectiveList(configValue, level, 'knowledge')),
    };
}

/**
 * Rejects a save of a list whose stored version is no longer the one the
 * caller loaded. Only the lists the save writes are checked, and only when
 * the caller sent the revision it loaded (the CLI and other writers that
 * send none keep their behaviour).
 */
export function assertCustomAgentsRevisions(
    configValue: CodeReviewConfigValueLike | undefined,
    level: CustomAgentConfigLevel,
    configToSave: Record<string, unknown> | undefined,
    expected: ExpectedCustomAgentsRevisions | undefined,
): void {
    if (!expected || !configToSave) return;

    const current = customAgentsRevisionsAtLevel(configValue, level);
    const stale = CUSTOM_AGENTS_FIELDS.filter(
        (field) =>
            configToSave[field] !== undefined &&
            typeof expected[field] === 'string' &&
            expected[field] !== current[field],
    );

    if (stale.length > 0) throw new StaleCustomAgentsError(stale);
}
