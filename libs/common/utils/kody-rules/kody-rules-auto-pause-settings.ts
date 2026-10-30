import { deepMerge } from '@libs/common/utils/deep';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';
import { CodeReviewParameter } from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';

type CodeReviewConfigLike =
    Pick<CodeReviewParameter, 'configs' | 'repositories'> | null | undefined;

type Level = Record<string, unknown>;

const isOn = (...levels: Level[]): boolean =>
    deepMerge<Level>(...levels).kodyRulesAutoPauseEnabled === true;

/**
 * Resolves `kodyRulesAutoPauseEnabled` for a rule at the level the rule lives
 * on: default → global → repository → directory. A rule is resolved against the
 * team whose config lists its repository. Global rules, and rules on a
 * repository no team configures, apply across teams, so they need every team's
 * global level on.
 *
 * Takes one code review config per team of the organization.
 */
export function createKodyRulesAutoPauseResolver(
    teamConfigs: CodeReviewConfigLike[],
): (rule: { repositoryId?: string; directoryId?: string }) => boolean {
    const defaults = getDefaultKodusConfigFile() as Level;

    // A team without a saved config runs on the defaults, so it counts as off.
    const everyTeamGlobalOn =
        teamConfigs.length > 0 &&
        teamConfigs.every((config) =>
            isOn(defaults, (config?.configs ?? {}) as Level),
        );

    // First team listing a repository owns it.
    const byRepository = new Map<
        string,
        {
            levels: Level[];
            directories: Map<string, Level>;
        }
    >();
    for (const config of teamConfigs) {
        for (const repository of config?.repositories ?? []) {
            const key = String(repository.id);
            if (byRepository.has(key)) continue;
            byRepository.set(key, {
                levels: [
                    defaults,
                    (config?.configs ?? {}) as Level,
                    (repository.configs ?? {}) as Level,
                ],
                directories: new Map(
                    (repository.directories ?? []).map((dir) => [
                        dir.id,
                        (dir.configs ?? {}) as Level,
                    ]),
                ),
            });
        }
    }

    return ({ repositoryId, directoryId }) => {
        const repository = byRepository.get(String(repositoryId));
        if (!repository) return everyTeamGlobalOn;

        return isOn(
            ...repository.levels,
            (directoryId && repository.directories.get(directoryId)) || {},
        );
    };
}
