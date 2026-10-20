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
    const configs = teamConfigs.filter(
        (config): config is NonNullable<CodeReviewConfigLike> => !!config,
    );

    const everyTeamGlobalOn =
        configs.length > 0 &&
        configs.every((config) =>
            isOn(defaults, (config.configs ?? {}) as Level),
        );

    return ({ repositoryId, directoryId }) => {
        for (const config of configs) {
            const repository = (config.repositories ?? []).find(
                (repo) => String(repo.id) === String(repositoryId),
            );
            if (!repository) continue;

            const directory = directoryId
                ? (repository.directories ?? []).find(
                      (dir) => dir.id === directoryId,
                  )
                : undefined;

            return isOn(
                defaults,
                (config.configs ?? {}) as Level,
                (repository.configs ?? {}) as Level,
                (directory?.configs ?? {}) as Level,
            );
        }

        return everyTeamGlobalOn;
    };
}
