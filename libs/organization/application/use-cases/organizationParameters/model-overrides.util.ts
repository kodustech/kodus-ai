/**
 * Helpers to enumerate and clear per-scope `byokModel` overrides inside a stored
 * code-review config. The config is untyped jsonb shaped as:
 *   { configs: { byokModel? }, repositories: [
 *       { id, name, configs: { byokModel? }, directories: [
 *           { id, name, configs: { byokModel? } } ] } ] }
 * An empty-string `byokModel` means "inherit", so it is NOT an override.
 */

export type OverrideScope = 'global' | 'repository' | 'directory';

export interface ModelOverrideLocation {
    scope: OverrideScope;
    repositoryId?: string;
    repositoryName?: string;
    directoryId?: string;
    directoryName?: string;
}

export interface CollectedModelOverride extends ModelOverrideLocation {
    model: string;
}

/** A location targeted for clearing (from the client / "clear all"). */
export interface ClearOverrideTarget {
    repositoryId?: string;
    directoryId?: string;
}

function overrideModel(configs: unknown): string | undefined {
    const value = (configs as { byokModel?: unknown } | undefined)?.byokModel;
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

/** Enumerate every non-empty `byokModel` override with its location. */
export function collectModelOverrides(
    configValue: unknown,
): CollectedModelOverride[] {
    const config = configValue as
        | {
              configs?: unknown;
              repositories?: Array<{
                  id?: string;
                  name?: string;
                  configs?: unknown;
                  directories?: Array<{
                      id?: string;
                      name?: string;
                      configs?: unknown;
                  }>;
              }>;
          }
        | undefined;
    if (!config) return [];

    const out: CollectedModelOverride[] = [];

    const globalModel = overrideModel(config.configs);
    if (globalModel) {
        out.push({ scope: 'global', model: globalModel });
    }

    for (const repo of config.repositories ?? []) {
        const repoModel = overrideModel(repo?.configs);
        if (repoModel) {
            out.push({
                scope: 'repository',
                repositoryId: repo?.id,
                repositoryName: repo?.name,
                model: repoModel,
            });
        }
        for (const dir of repo?.directories ?? []) {
            const dirModel = overrideModel(dir?.configs);
            if (dirModel) {
                out.push({
                    scope: 'directory',
                    repositoryId: repo?.id,
                    repositoryName: repo?.name,
                    directoryId: dir?.id,
                    directoryName: dir?.name,
                    model: dirModel,
                });
            }
        }
    }

    return out;
}

/**
 * Return a deep-cloned config with `byokModel` set to '' (inherit) at each
 * targeted scope. Only the `byokModel` field is touched — everything else is
 * preserved. `clearedCount` reflects targets that actually matched an existing
 * override. A target with no `repositoryId` clears the global scope.
 */
export function clearModelOverrides(
    configValue: unknown,
    targets: ClearOverrideTarget[],
): { configValue: unknown; clearedCount: number } {
    const config = structuredClone(configValue) as any;
    let clearedCount = 0;

    const clearAt = (configs: any): boolean => {
        if (configs && overrideModel(configs)) {
            configs.byokModel = '';
            return true;
        }
        return false;
    };

    // Index repos by id once so repeated targets don't rescan the array.
    // Keep first-match semantics (matching the previous `.find()`): if an id
    // somehow appears twice, only the first occurrence is addressable.
    const repoById = new Map<string, any>();
    for (const r of config?.repositories ?? []) {
        if (r?.id && !repoById.has(r.id)) {
            repoById.set(r.id, r);
        }
    }

    for (const target of targets) {
        if (!target.repositoryId) {
            if (clearAt(config?.configs)) clearedCount++;
            continue;
        }
        const repo = repoById.get(target.repositoryId);
        if (!repo) continue;

        if (!target.directoryId) {
            if (clearAt(repo.configs)) clearedCount++;
            continue;
        }
        const dir = (repo.directories ?? []).find(
            (d: any) => d?.id === target.directoryId,
        );
        if (dir && clearAt(dir.configs)) clearedCount++;
    }

    return { configValue: config, clearedCount };
}
