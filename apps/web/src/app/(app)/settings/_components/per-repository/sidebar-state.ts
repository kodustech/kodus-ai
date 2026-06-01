import { countConfigOverrides } from "../../_utils/count-overrides";
import {
    FormattedConfigLevel,
    type FormattedCodeReviewConfig,
    type FormattedGlobalCodeReviewConfig,
} from "../../code-review/_types";

type SidebarDirectoryItem = {
    id: string;
    name: string;
    path: string;
    overrideCount: number;
    configs: FormattedCodeReviewConfig;
};

type SidebarRepositoryItem = {
    id: string;
    name: string;
    isSelected: boolean;
    overrideCount: number;
    directories: SidebarDirectoryItem[];
};

export const buildPerRepositorySidebarItems = (
    configValue: Pick<FormattedGlobalCodeReviewConfig, "repositories">,
): SidebarRepositoryItem[] => {
    return configValue.repositories
        .filter(
            (repository) =>
                repository.isSelected || repository.directories.length > 0,
        )
        .map((repository) => ({
            id: repository.id,
            name: repository.name,
            isSelected: repository.isSelected,
            overrideCount: repository.isSelected
                ? countConfigOverrides(
                      repository.configs,
                      FormattedConfigLevel.REPOSITORY,
                  )
                : 0,
            directories: repository.directories.map((directory) => ({
                id: directory.id,
                name: directory.name,
                path: directory.folders?.[0]?.path ?? '',
                overrideCount: countConfigOverrides(
                    directory.configs,
                    FormattedConfigLevel.DIRECTORY,
                ),
                configs: directory.configs,
            })),
        }));
};
