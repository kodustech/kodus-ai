type NamedRepository = { organizationName: string; name: string };

/**
 * A repository's owner and name for display. GitLab and Forgejo store the
 * full path in `name` (`group/sub/repo`), so a name with a slash is split at
 * its last one instead of being prefixed with the owner again (#2718).
 * GitHub, Bitbucket and Azure Repos names cannot contain a slash.
 */
export const repositoryNameParts = ({
    organizationName,
    name,
}: NamedRepository): { owner: string; repo: string } => {
    const slash = name.lastIndexOf("/");
    return slash === -1
        ? { owner: organizationName, repo: name }
        : { owner: name.slice(0, slash), repo: name.slice(slash + 1) };
};

/** `owner/name`, with the owner shown once. */
export const repositoryFullName = (repository: NamedRepository): string => {
    const { owner, repo } = repositoryNameParts(repository);
    return `${owner}/${repo}`;
};
