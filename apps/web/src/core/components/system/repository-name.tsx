import { repositoryNameParts } from "src/core/utils/repository-name";

/** `owner/name` with the owner muted, the owner shown once (#2718). */
export const RepositoryName = ({
    repository,
}: {
    repository: { organizationName: string; name: string };
}) => {
    const { owner, repo } = repositoryNameParts(repository);
    return (
        <>
            <span className="text-text-secondary">{owner}/</span>
            {repo}
        </>
    );
};
