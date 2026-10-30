import type {
    CustomAgentsRevisions,
    FormattedCodeReviewConfig,
    FormattedGlobalCodeReviewConfig,
} from "../code-review/_types";

export type ScopedCodeReviewConfig = FormattedCodeReviewConfig &
    CustomAgentsRevisions & {
        id: string;
        name: string;
        isSelected: boolean;
        displayName: string;
    };

export const resolveCodeReviewConfigForScope = (
    config: FormattedGlobalCodeReviewConfig,
    repositoryId?: string,
    directoryId?: string,
): ScopedCodeReviewConfig | undefined => {
    if (!repositoryId || repositoryId === "global") {
        return {
            ...config.configs,
            // Beside the global settings, like a repository's or directory's.
            customAgentsRevision: config.customAgentsRevision,
            knowledgeRevision: config.knowledgeRevision,
            id: "global",
            name: "Global",
            isSelected: true,
            displayName: "Global",
        };
    }

    const repository = config.repositories.find(
        (item) => item.id === repositoryId,
    );
    if (!repository) {
        return undefined;
    }

    const directory = repository.directories?.find(
        (item) => item.id === directoryId,
    );

    if (!directory) {
        const { configs, ...rest } = repository;

        return {
            ...configs,
            ...rest,
            displayName: repository.name,
        };
    }

    const { configs, ...rest } = directory;

    return {
        ...configs,
        ...rest,
        displayName: `${repository.name}${directory.folders?.[0]?.path ?? ''}`,
    };
};
