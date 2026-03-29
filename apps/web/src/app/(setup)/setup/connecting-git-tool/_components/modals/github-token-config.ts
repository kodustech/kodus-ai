type GithubTokenConfigParams = {
    githubEnterpriseServerPatEnabled: boolean;
};

type ResolveGithubTokenHostParams = {
    githubEnterpriseServerPatEnabled: boolean;
    selfHosted: boolean;
    selfHostedUrl?: string;
};

type GetGithubTokenErrorMessageParams = {
    selfHosted: boolean;
};

export const getGithubTokenConfig = ({
    githubEnterpriseServerPatEnabled,
}: GithubTokenConfigParams) => ({
    showSelfHosted: githubEnterpriseServerPatEnabled,
});

export const resolveGithubTokenHost = ({
    githubEnterpriseServerPatEnabled,
    selfHosted,
    selfHostedUrl,
}: ResolveGithubTokenHostParams) => {
    const normalizedUrl = selfHostedUrl?.trim();

    return githubEnterpriseServerPatEnabled && selfHosted
        ? normalizedUrl || undefined
        : undefined;
};

export const isValidGithubEnterpriseUrl = (url: string) => {
    try {
        const parsedUrl = new URL(url);

        return (
            parsedUrl.protocol === "https:" || parsedUrl.protocol === "http:"
        );
    } catch {
        return false;
    }
};

export const getGithubTokenErrorMessage = ({
    selfHosted,
}: GetGithubTokenErrorMessageParams) =>
    selfHosted ? "Invalid Token or GitHub Enterprise URL" : "Invalid Token";
