/**
 * The lower-cased names a listed repository goes by: owner/name forms
 * (`full_name`, `organizationName/name`, a GitLab path) and the bare name,
 * which is how Azure records a pull request's repository.
 */
export type RepositoryNames = { full: string[]; bare: string[] };

export const repositoryNamesOf = (
    repository: Record<string, unknown> | null | undefined,
): RepositoryNames => {
    const names = [
        repository?.full_name,
        repository?.organizationName && repository?.name
            ? `${repository.organizationName}/${repository.name}`
            : undefined,
        repository?.name,
    ]
        .filter((name): name is string => typeof name === 'string' && !!name)
        .map((name) => name.toLowerCase());
    return {
        full: [...new Set(names.filter((name) => name.includes('/')))],
        bare: [...new Set(names.filter((name) => !name.includes('/')))],
    };
};

/**
 * Whether a recorded name (owner/name, or Azure's bare name) names the
 * listed repository; undefined when the listing has no name of that form to
 * compare with.
 */
export const recordedNameMatches = (
    names: RepositoryNames,
    recorded: string,
): boolean | undefined => {
    const name = recorded.toLowerCase();
    const forms = name.includes('/') ? names.full : names.bare;
    return forms.length ? forms.includes(name) : undefined;
};
