/**
 * Public runtime config exposed to the browser.
 *
 * Anything in this shape is serialized into the SSR HTML and visible to
 * any user with devtools. Treat it like public data. Server-only secrets
 * (database URLs, OAuth client secrets, internal hostnames) MUST NOT
 * appear here — keep them as direct `process.env.X` reads in server-only
 * modules guarded by `import 'server-only'`.
 */
export type PublicConfig = {
    githubInstallUrl: string;
    bitbucketInstallUrl: string;
    gitlabClientId: string;
    gitlabRedirectUrl: string;
    gitlabScopes: string;
    gitlabOauthUrl: string;
    termsAndConditions: string;
    supportDocsUrl: string;
    supportDiscordInviteUrl: string;
    supportTalkToFounderUrl: string;
    tokenDocsGithub: string;
    tokenDocsGitlab: string;
    tokenDocsBitbucket: string;
    tokenDocsAzureRepos: string;
    tokenDocsForgejo: string;
    ruleFilesDocs: string;
    releaseVersion: string;
    // Distinguishes "development" / "production" / "self-hosted" so
    // client components (e.g. sso-callback) can decide things like
    // shared-cookie domain without reading process.env in the browser.
    nodeEnv: string;

    apiPublicUrl: string;

    helpdeskUrl: string;
};
// Note: WEB_TERMS_AND_CONDITIONS has no client consumer yet, but it's
// populated end-to-end (SSM → CI workflow → .env, with a real Notion URL
// in dev). Keeping it exposed in publicConfig so a future Terms page can
// just read useConfig().termsAndConditions without re-plumbing infra.
