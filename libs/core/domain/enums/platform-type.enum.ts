export enum PlatformType {
    INTERNAL = 'INTERNAL',
    GITHUB = 'GITHUB',
    GITLAB = 'GITLAB',
    JIRA = 'JIRA',
    SLACK = 'SLACK',
    NOTION = 'NOTION',
    MSTEAMS = 'MSTEAMS',
    DISCORD = 'DISCORD',
    AZURE_BOARDS = 'AZURE_BOARDS',
    AZURE_REPOS = 'AZURE_REPOS',
    KODUS_WEB = 'KODUS_WEB',
    BITBUCKET = 'BITBUCKET',
    FORGEJO = 'FORGEJO',
}

const PLATFORM_ALIASES: Record<string, PlatformType> = {
    GITHUB: PlatformType.GITHUB,
    GITLAB: PlatformType.GITLAB,
    BITBUCKET: PlatformType.BITBUCKET,
    AZURE_REPOS: PlatformType.AZURE_REPOS,
    AZUREDEVOPS: PlatformType.AZURE_REPOS,
    AZURE_DEVOPS: PlatformType.AZURE_REPOS,
    AZURE_REPOSITORIES: PlatformType.AZURE_REPOS,
    FORGEJO: PlatformType.FORGEJO,
};

export function parsePlatformType(value?: string): PlatformType | undefined {
    if (!value) return undefined;
    if (Object.values(PlatformType).includes(value as PlatformType))
        return value as PlatformType;
    const normalized = value
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, '_');
    return Object.hasOwn(PLATFORM_ALIASES, normalized)
        ? PLATFORM_ALIASES[normalized]
        : undefined;
}
