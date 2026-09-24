import type { PullRequestExecution } from "./types";

/**
 * Review-screen deep link. The review page reads `?file=<path>` and
 * `?suggestion=<id>`: with an id it scrolls to that finding's card and lights
 * it up, with only a path it selects the file. Both params are independent, so
 * whichever the caller knows is emitted — a file-only link still beats landing
 * on the top of a large diff.
 *
 * Callers: the PR-list count (backend tags each row with its first delivered
 * suggestion) and the cockpit suggestions explorer.
 */
export const buildReviewDeepLinkUrl = (
    repositoryId: string,
    prNumber: number,
    target?: { id?: string | null; filePath?: string | null } | null,
): string => {
    const base = `/pull-requests/${repositoryId}/${prNumber}`;
    const params: string[] = [];
    if (target?.filePath) {
        params.push(`file=${encodeURIComponent(target.filePath)}`);
    }
    if (target?.id) {
        params.push(`suggestion=${encodeURIComponent(target.id)}`);
    }
    return params.length ? `${base}?${params.join("&")}` : base;
};

/**
 * Constrói a URL real do Pull Request baseado no provider e dados do repositório
 */
export const buildPullRequestUrl = (pr: PullRequestExecution): string => {
    const { provider, repositoryId, prNumber, url } = pr;

    // Tenta extrair informações da URL da API para construir a URL real
    switch (provider) {
        case "GITHUB":
            // GitHub API URL: https://api.github.com/repos/{owner}/{repo}/pulls/{number}
            if (url && url.includes("api.github.com")) {
                const apiMatch = url.match(
                    /api\.github\.com\/repos\/([^\/]+)\/([^\/]+)\/pulls/,
                );
                if (apiMatch) {
                    const [, owner, repo] = apiMatch;
                    return `https://github.com/${owner}/${repo}/pull/${prNumber}`;
                }
            }
            // Se a URL já é do GitHub (não API), usa ela
            if (
                url &&
                url.includes("github.com") &&
                !url.includes("api.github.com")
            ) {
                return url;
            }
            break;

        case "GITLAB":
            // GitLab API URL: https://gitlab.com/api/v4/projects/{id}/merge_requests/{number}
            if (url && url.includes("gitlab.com")) {
                // Tenta extrair o project ID da URL da API
                const projectMatch = url.match(
                    /gitlab\.com\/api\/v4\/projects\/([^\/]+)/,
                );
                if (projectMatch) {
                    // Para GitLab, geralmente precisamos do namespace/project, não apenas o ID
                    // Por enquanto, construímos uma URL genérica com o repositoryName se disponível
                    if (pr.repositoryName) {
                        // Assume que o repositoryName pode conter o namespace
                        return `https://gitlab.com/${pr.repositoryName}/-/merge_requests/${prNumber}`;
                    }
                }
            }
            // Se a URL já é do GitLab (não API), usa ela
            if (url && url.includes("gitlab.com") && !url.includes("/api/")) {
                return url;
            }
            break;

        case "BITBUCKET":
            // Bitbucket API URL: https://api.bitbucket.org/2.0/repositories/{workspace}/{repo}/pullrequests/{number}
            if (url && url.includes("api.bitbucket.org")) {
                const apiMatch = url.match(
                    /api\.bitbucket\.org\/2\.0\/repositories\/([^\/]+)\/([^\/]+)/,
                );
                if (apiMatch) {
                    const [, workspace, repo] = apiMatch;
                    return `https://bitbucket.org/${workspace}/${repo}/pull-requests/${prNumber}`;
                }
            }
            // Se a URL já é do Bitbucket (não API), usa ela
            if (
                url &&
                url.includes("bitbucket.org") &&
                !url.includes("api.bitbucket.org")
            ) {
                return url;
            }
            break;

        case "AZURE_REPOS":
            // Azure DevOps tem URLs complexas, por enquanto mantém a original
            if (
                url &&
                url.includes("dev.azure.com") &&
                !url.includes("/_apis/")
            ) {
                return url;
            }
            // Tenta construir URL básica se tiver informações suficientes
            if (url && url.includes("/_apis/")) {
                const azureMatch = url.match(
                    /dev\.azure\.com\/([^\/]+)\/([^\/]+)\/_apis/,
                );
                if (azureMatch && pr.repositoryName) {
                    const [, organization, project] = azureMatch;
                    return `https://dev.azure.com/${organization}/${project}/_git/${pr.repositoryName}/pullrequest/${prNumber}`;
                }
            }
            break;
    }

    // Fallback: se não conseguiu construir uma URL específica, usa a original ou placeholder
    if (url && !url.includes("/api") && !url.includes("/_apis/")) {
        return url;
    }

    // Último fallback: link interno temporário
    return `#pr-${prNumber}`;
};

/**
 * Verifica se a URL é válida (não é da API)
 */
export const isValidPullRequestUrl = (url: string): boolean => {
    return Boolean(url && !url.includes("/api/") && url.startsWith("http"));
};
