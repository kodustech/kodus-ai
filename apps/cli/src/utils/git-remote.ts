import type { PlatformType } from '../types/cli.js';

export function extractOrgRepoFromRemote(
    remoteUrl: string | null | undefined,
): { org: string; repo: string } | null {
    if (!remoteUrl) {return null;}

    const url = remoteUrl.trim();

    // Azure DevOps SSH (new): git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
    // Azure DevOps SSH (old): git@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}
    const azureSsh = url.match(
        /(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)[:/]v3\/([^/]+)\/[^/]+\/([^/.]+)/,
    );
    if (azureSsh) {return { org: azureSsh[1], repo: azureSsh[2] };}

    // Azure DevOps HTTPS (new): https://dev.azure.com/{org}/{project}/_git/{repo}
    const azureHttpsNew = url.match(
        /dev\.azure\.com\/([^/]+)\/[^/]+\/_git\/([^/.?]+)/,
    );
    if (azureHttpsNew) {return { org: azureHttpsNew[1], repo: azureHttpsNew[2] };}

    // Azure DevOps HTTPS (old): https://{org}.visualstudio.com/{project}/_git/{repo}
    const azureHttpsOld = url.match(
        /^https?:\/\/([^.]+)\.visualstudio\.com\/[^/]+\/_git\/([^/.?]+)/,
    );
    if (azureHttpsOld) {return { org: azureHttpsOld[1], repo: azureHttpsOld[2] };}

    // Bitbucket Server (self-hosted): .../scm/{proj}/{repo}.git
    const bitbucketServer = url.match(/\/scm\/([^/]+)\/([^/.]+)/);
    if (bitbucketServer)
        {return { org: bitbucketServer[1], repo: bitbucketServer[2] };}

    // SSH SCP-like: git@host:path — handles subgroups (org/sub/repo → org, repo)
    const sshScp = url.match(/^[^@/]+@[^:]+:(.+)/);
    if (sshScp) {
        const parts = sshScp[1].replace(/\.git$/, '').split('/').filter(Boolean);
        if (parts.length >= 2)
            {return { org: parts[0], repo: parts[parts.length - 1] };}
    }

    // SSH with protocol: ssh://[user@]host[:port]/path
    const sshProto = url.match(/^ssh:\/\/[^/]+\/(.+)/);
    if (sshProto) {
        const parts = sshProto[1]
            .replace(/\.git$/, '')
            .split('/')
            .filter(Boolean);
        if (parts.length >= 2)
            {return { org: parts[0], repo: parts[parts.length - 1] };}
    }

    // HTTPS: https://[user@]host/path — GitHub, GitLab, Bitbucket, self-hosted
    const httpsMatch = url.match(/^https?:\/\/[^/]+\/(.+)/);
    if (httpsMatch) {
        const parts = httpsMatch[1]
            .replace(/\.git$/, '')
            .replace(/\?.*$/, '')
            .split('/')
            .filter(Boolean);
        if (parts.length >= 2)
            {return { org: parts[0], repo: parts[parts.length - 1] };}
    }

    return null;
}

export function inferPlatformFromRemote(
    remote: string | null | undefined,
): PlatformType {
    if (!remote) {
        return undefined;
    }

    const host = extractRemoteHost(remote);
    if (!host) {
        return undefined;
    }

    if (host === 'github.com') {
        return 'GITHUB';
    }
    if (host === 'gitlab.com') {
        return 'GITLAB';
    }
    if (host === 'bitbucket.org') {
        return 'BITBUCKET';
    }
    if (
        host === 'dev.azure.com' ||
        host === 'ssh.dev.azure.com' ||
        host === 'visualstudio.com' ||
        host.endsWith('.visualstudio.com')
    ) {
        return 'AZURE_REPOS';
    }

    return undefined;
}

function extractRemoteHost(remote: string): string | undefined {
    const value = remote.trim().toLowerCase();
    if (!value) {
        return undefined;
    }

    try {
        const url = new URL(value);
        if (url.hostname) {
            return url.hostname.toLowerCase();
        }
    } catch {
        // Fallback below for SCP-like syntax.
    }

    const scpLike = value.match(/^(?:[^@/]+@)?([^:/]+):.+$/);
    return scpLike?.[1];
}
