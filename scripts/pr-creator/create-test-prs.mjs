#!/usr/bin/env node

import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

const CONFIG = {
    kodusUrl: process.env.KODUS_URL || 'https://api.kodus.ai',
    email: process.env.KODUS_EMAIL,
    password: process.env.KODUS_PASSWORD,
    totalPRs: parseInt(process.env.TOTAL_PRS || '10'),
    totalPRsPerAccount: parseInt(
        process.env.TOTAL_PRS_PER_ACCOUNT || process.env.TOTAL_PRS || '10',
    ),
    targetBranch: process.env.TARGET_BRANCH || 'main',
    sourceBranchPattern: process.env.SOURCE_BRANCH_PATTERN || undefined,
    teamsLimit: parseInt(process.env.TEAMS_LIMIT || '10'),
    reposLimit: parseInt(process.env.REPOS_LIMIT || '20'),
    syncForks: process.env.SYNC_FORKS !== 'false',
    closeExistingPRs: process.env.CLOSE_EXISTING_PRS === 'true',
    // Tokens via env (prioridade)
    githubToken: process.env.GITHUB_TOKEN,
    gitlabToken: process.env.GITLAB_TOKEN,
    bitbucketToken: process.env.BITBUCKET_TOKEN,
    bitbucketEmail:
        process.env.BITBUCKET_EMAIL || 'gabriel.malinosqui@kodus.io',
    azureDevOpsToken: process.env.AZURE_DEVOPS_TOKEN,
    // 1Password item names (fallback)
    opGHToken: process.env.OP_GH_TOKEN || 'GitHub Token',
    opGLToken: process.env.OP_GL_TOKEN || 'Gitlab Token',
    opBBToken: process.env.OP_BB_TOKEN || 'Bitbucket Token',
    opADOToken: process.env.OP_ADO_TOKEN || 'Azure Devops Token',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

// Cache de repositórios Bitbucket para mapeamento de slug → full_name
let bitbucketReposCache = {};

let authTokens = {};

async function loadAccounts() {
    const envPath = process.env.KODUS_ACCOUNTS_FILE;
    const accountsPath = envPath
        ? path.resolve(process.cwd(), envPath)
        : DEFAULT_ACCOUNTS_FILE;

    if (!envPath) {
        try {
            await fs.access(accountsPath);
        } catch {
            return null;
        }
    }

    try {
        const raw = await fs.readFile(accountsPath, 'utf-8');
        const data = JSON.parse(raw);
        const accounts = Array.isArray(data) ? data : data.accounts;
        if (!Array.isArray(accounts) || accounts.length === 0) {
            console.warn(`⚠️  No accounts found in ${accountsPath}`);
            return null;
        }
        return accounts.map((account, index) => ({
            email: account.email,
            password: account.password,
            totalPrs: account.totalPrs,
            index,
        }));
    } catch (error) {
        console.warn(`⚠️  Failed to load accounts file: ${error.message}`);
        return null;
    }
}

function getBitbucketAuthHeader(token) {
    const credentials = Buffer.from(
        `${CONFIG.bitbucketEmail}:${token}`,
    ).toString('base64');
    return `Basic ${credentials}`;
}

function getAzureAuthHeader(token) {
    const credentials = Buffer.from(`:${token}`).toString('base64');
    return `Basic ${credentials}`;
}

async function loadBitbucketRepos() {
    if (Object.keys(bitbucketReposCache).length > 0) return bitbucketReposCache;

    const token = CONFIG.bitbucketToken;
    if (!token) return {};

    try {
        let allRepos = [];
        let url = `https://api.bitbucket.org/2.0/repositories?role=member&pagelen=100`;

        do {
            const response = await fetch(url, {
                headers: { Authorization: getBitbucketAuthHeader(token) },
            });
            if (!response.ok) {
                console.warn(
                    `Failed to list Bitbucket repos: ${response.status}`,
                );
                return {};
            }
            const data = await response.json();
            allRepos.push(...(data.values || []));
            url = data.next;
        } while (url);

        const repoMap = {};
        for (const repo of allRepos) {
            repoMap[repo.slug] = repo.full_name;
        }

        bitbucketReposCache = repoMap;
        console.log(
            `   📋 Loaded ${Object.keys(repoMap).length} Bitbucket repositories`,
        );
        return repoMap;
    } catch (error) {
        console.warn(`Failed to load Bitbucket repos: ${error}`);
        return {};
    }
}

async function runForAccount(account) {
    const totalPrsTarget = account.totalPrs || CONFIG.totalPRsPerAccount;
    const accessToken = await login(account.email, account.password);
    const user = await getUserInfo(accessToken);
    console.log(`👤 Logged in as: ${user.email}`);
    console.log(
        `🏢 Organization: ${user.organization?.name} (${user.organization?.uuid})`,
    );

    if (!user.teamMember || user.teamMember.length === 0) {
        console.error('❌ No teams found');
        process.exit(1);
    }

    const teams = user.teamMember
        .map((tm) => tm.team)
        .filter((team) => team)
        .slice(0, CONFIG.teamsLimit);

    console.log(
        `\n📋 Found ${teams.length} teams (limit: ${CONFIG.teamsLimit})`,
    );

    const allRepos = [];
    for (const team of teams) {
        console.log(`\n📚 Total repos found: ${allRepos.length}`);

        // Log de exemplo para ver a estrutura
        if (allRepos.length > 0) {
            console.log(`\n📝 Sample repository structure:`);
            console.log(JSON.stringify(allRepos[0], null, 2));
        }
        const repos = await getRepositories(
            accessToken,
            team.uuid,
            user.organization?.uuid,
        );
        allRepos.push(...repos);
        console.log(`   Found ${repos.length} repos`);
    }

    console.log(`\n📚 Total repos found: ${allRepos.length}`);

    // Filtra apenas repositórios selecionados
    const selectedRepos = allRepos.filter((repo) => repo.selected === true);

    // Log dos valores de selected
    const selectedCount = allRepos.filter((r) => r.selected === true).length;
    const notSelectedCount = allRepos.filter(
        (r) => r.selected === false,
    ).length;
    const undefinedCount = allRepos.filter(
        (r) => r.selected === undefined,
    ).length;

    console.log(`   ✅ selected=true: ${selectedCount}`);
    console.log(`   ⏸️  selected=false: ${notSelectedCount}`);

    const reposToProcess = selectedRepos.slice(0, CONFIG.reposLimit);

    const platformsUsed = [
        ...new Set(
            reposToProcess
                .map((r) => inferPlatformFromUrl(r.http_url))
                .filter(Boolean),
        ),
    ];

    console.log(
        `\n🧩 Platforms detected: ${platformsUsed.join(', ') || 'none'}`,
    );
    console.log(
        `📚 Repos to process: ${reposToProcess.length} (limit: ${CONFIG.reposLimit})`,
    );

    if (platformsUsed.length === 0) {
        console.error('❌ No platforms detected in repositories');
        process.exit(1);
    }

    if (platformsUsed.includes('bitbucket')) {
        await loadBitbucketRepos();
    }

    await fetchTokensFrom1Password(platformsUsed);

    const missingTokens = platformsUsed.filter((p) => !authTokens[p]);
    if (missingTokens.length > 0) {
        console.error(`❌ Missing tokens for: ${missingTokens.join(', ')}`);
        console.error(`\nConfigure these items in 1Password:`);
        const opNames = {
            github: CONFIG.opGHToken,
            gitlab: CONFIG.opGLToken,
            bitbucket: CONFIG.opBBToken,
            azuredevOps: CONFIG.opADOToken,
        };
        missingTokens.forEach((p) => {
            console.error(`   - ${opNames[p] || p} (for ${p})`);
        });
        process.exit(1);
    }

    console.log('\n🔑 All required tokens configured ✓');

    const prsToCreate = [];
    for (const repo of reposToProcess) {
        if (prsToCreate.length >= totalPrsTarget) break;

        const type = inferPlatformFromUrl(repo.http_url);
        const token = authTokens[type];
        if (!token) {
            console.log(
                `⚠️  Skipped ${repo.full_name || repo.name}: no token for ${type}`,
            );
            continue;
        }

        const forkInfo = await detectFork(type, token, repo);
        if (forkInfo.isFork && CONFIG.syncForks) {
            console.log(`   🔗 Fork detected, syncing with upstream...`);
            await syncForkWithUpstream(type, token, repo, forkInfo);
        }

        if (CONFIG.closeExistingPRs) {
            await closeAllPRs(repo, type, token);
            // Pequeno delay para API atualizar
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        const branches = await getBranches(type, token, repo);
        const existingPRs = await getOpenPRs(type, token, repo);
        const defaultBranchName =
            type === 'azuredevops'
                ? repo.default_branch?.replace('refs/heads/', '')
                : repo.default_branch;

        console.log(
            `   📋 Found ${branches.length} branches (${defaultBranchName} is default)`,
        );
        console.log(`   🔀 Existing PRs: ${existingPRs.length}`);

        const filteredByDefault = branches.filter(
            (branch) => branch !== defaultBranchName,
        );
        console.log(
            `   ✂️  After filtering out default: ${filteredByDefault.length}`,
        );

        const filteredByPattern = CONFIG.sourceBranchPattern
            ? filteredByDefault.filter((branch) =>
                  branch.includes(CONFIG.sourceBranchPattern),
              )
            : filteredByDefault;
        console.log(
            `   🔍 After filtering by pattern (${CONFIG.sourceBranchPattern || 'none'}): ${filteredByPattern.length}`,
        );

        const filteredByPRs = filteredByPattern.filter(
            (branch) => !existingPRs.includes(branch),
        );
        console.log(
            `   🚫 After filtering existing PRs: ${filteredByPRs.length}`,
        );

        const availableBranches = filteredByPRs.slice(
            0,
            Math.ceil(totalPrsTarget / reposToProcess.length),
        );

        if (availableBranches.length === 0 && branches.length > 1) {
            console.log(
                `      ⚠️  All branches filtered out - maybe all have existing PRs?`,
            );
        }

        for (const branch of availableBranches) {
            if (prsToCreate.length >= totalPrsTarget) break;
            let repoNameForPR = repo.full_name || repo.name;
            if (type === 'bitbucket') {
                repoNameForPR = bitbucketReposCache[repo.name] || repoNameForPR;
            }
            prsToCreate.push({
                repoName: repoNameForPR,
                repoId: repo.id,
                repoUrl: repo.http_url,
                defaultBranch: defaultBranchName,
                sourceBranch: branch,
                targetBranch: defaultBranchName,
                platform: type,
            });
        }
    }

    console.log(`\n📝 Found ${prsToCreate.length} PRs to create`);

    const createdPRs = [];
    for (const pr of prsToCreate) {
        const prUrl = await createPR(pr, authTokens[pr.platform]);
        if (prUrl) {
            createdPRs.push(prUrl);
        }
    }

    console.log('\n✨ Done!');

    if (createdPRs.length > 0) {
        console.log('\n📋 Created PRs Summary:');
        console.log(`   Total: ${createdPRs.length} PR(s)\n`);
        createdPRs.forEach((url, index) => {
            console.log(`   ${index + 1}. ${url}`);
        });
    }

    return createdPRs;
}

/**
 * Load targeted PR config from prs.json or PR_CONFIG env var.
 * Format: { "prs": [{ "repo": "owner/name", "head": "branch", "base": "main", "title?": "..." }] }
 */
async function loadTargetedPRs() {
    const envPath = process.env.PR_CONFIG;
    const defaultPath = path.join(__dirname, 'prs.json');
    const configPath = envPath
        ? path.resolve(process.cwd(), envPath)
        : defaultPath;

    try {
        await fs.access(configPath);
        const raw = await fs.readFile(configPath, 'utf-8');
        const data = JSON.parse(raw);
        const prs = Array.isArray(data) ? data : data.prs;
        if (!Array.isArray(prs) || prs.length === 0) return null;
        return prs;
    } catch {
        return null;
    }
}

/**
 * Azure DevOps variant: pr.repo is "<org>/<project>/<repoName>".
 * Abandon any active PR with the same sourceRef, then create a new one.
 */
async function closeAndCreateAzurePR(pr, token) {
    const segments = pr.repo.split('/').filter(Boolean);
    if (segments.length < 3) {
        console.error(`   ❌ Azure repo must be "<org>/<project>/<repo>": ${pr.repo}`);
        return null;
    }
    const [org, project, repoName] = segments.slice(-3);
    const apiBase = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${encodeURIComponent(repoName)}`;
    const headers = {
        'Authorization': getAzureAuthHeader(token),
        'Content-Type': 'application/json',
    };

    try {
        const sourceRef = `refs/heads/${pr.head}`;
        const listUrl =
            `${apiBase}/pullrequests?searchCriteria.status=active` +
            `&searchCriteria.sourceRefName=${encodeURIComponent(sourceRef)}` +
            `&api-version=6.0`;
        const listResp = await fetch(listUrl, { headers });
        if (listResp.ok) {
            const data = await listResp.json();
            for (const existing of data?.value ?? []) {
                console.log(`   🗑️  Abandoning existing PR !${existing.pullRequestId}`);
                await fetch(
                    `${apiBase}/pullrequests/${existing.pullRequestId}?api-version=6.0`,
                    {
                        method: 'PATCH',
                        headers,
                        body: JSON.stringify({ status: 'abandoned' }),
                    },
                );
                await new Promise((r) => setTimeout(r, 500));
            }
        }
    } catch (e) {
        console.warn(`   ⚠️  Failed to close existing Azure PRs: ${e.message}`);
    }

    const title = pr.title || `${pr.head} → ${pr.base}`;
    console.log(`📝 Creating PR for ${pr.repo}: ${pr.head} → ${pr.base}`);

    try {
        const response = await fetch(`${apiBase}/pullrequests?api-version=6.0`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                title,
                description: `Test PR: ${pr.head} → ${pr.base}`,
                sourceRefName: `refs/heads/${pr.head}`,
                targetRefName: `refs/heads/${pr.base}`,
            }),
        });
        if (!response.ok) {
            const err = await response.text();
            console.error(`   ❌ Failed: ${err}`);
            return null;
        }
        const data = await response.json();
        const prUrl =
            data?._links?.web?.href ||
            `https://dev.azure.com/${org}/${project}/_git/${repoName}/pullrequest/${data.pullRequestId}`;
        console.log(`   ✅ PR created: ${prUrl}`);
        await new Promise((r) => setTimeout(r, 1500));
        return prUrl;
    } catch (e) {
        console.error(`   ❌ Error: ${e.message}`);
        return null;
    }
}

/**
 * Close existing PR for a specific head branch, then create a new one.
 */
async function closeAndCreatePR(pr, token) {
    const platform = pr.platform || 'github';

    if (platform === 'azuredevops') {
        return await closeAndCreateAzurePR(pr, token);
    }

    const [owner, name] = pr.repo.split('/');

    // Close existing PR with same head branch
    try {
        if (platform === 'github') {
            const listResp = await fetch(
                `https://api.github.com/repos/${owner}/${name}/pulls?state=open&head=${owner}:${pr.head}`,
                { headers: { Authorization: `Bearer ${token}` } },
            );
            if (listResp.ok) {
                const existing = await listResp.json();
                for (const existingPr of existing) {
                    console.log(`   🗑️  Closing existing PR #${existingPr.number}`);
                    await fetch(
                        `https://api.github.com/repos/${owner}/${name}/pulls/${existingPr.number}`,
                        {
                            method: 'PATCH',
                            headers: {
                                'Authorization': `Bearer ${token}`,
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ state: 'closed' }),
                        },
                    );
                    await new Promise((r) => setTimeout(r, 1000));
                }
            }
        }
    } catch (e) {
        console.warn(`   ⚠️  Failed to close existing PRs: ${e.message}`);
    }

    // Create new PR
    const title = pr.title || `${pr.head} → ${pr.base}`;
    console.log(`📝 Creating PR for ${pr.repo}: ${pr.head} → ${pr.base}`);

    try {
        if (platform === 'github') {
            const response = await fetch(
                `https://api.github.com/repos/${owner}/${name}/pulls`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        title,
                        body: `Test PR: ${pr.head} → ${pr.base}`,
                        head: pr.head,
                        base: pr.base,
                    }),
                },
            );
            if (!response.ok) {
                const err = await response.text();
                console.error(`   ❌ Failed: ${err}`);
                return null;
            }
            const data = await response.json();
            console.log(`   ✅ PR created: ${data.html_url}`);
            await new Promise((r) => setTimeout(r, 2000));
            return data.html_url;
        }
    } catch (e) {
        console.error(`   ❌ Error: ${e.message}`);
        return null;
    }
}

/**
 * Run targeted mode — create specific PRs from prs.json config.
 */
async function runTargeted(targetedPRs) {
    const limit = CONFIG.totalPRs;
    if (limit && limit < targetedPRs.length) {
        // Distribute evenly across repos instead of taking the first N
        const byRepo = {};
        for (const pr of targetedPRs) {
            const repo = pr.repo;
            if (!byRepo[repo]) byRepo[repo] = [];
            byRepo[repo].push(pr);
        }
        const repos = Object.keys(byRepo);
        const perRepo = Math.ceil(limit / repos.length);
        const selected = [];
        for (const repo of repos) {
            selected.push(...byRepo[repo].slice(0, perRepo));
        }
        targetedPRs = selected.slice(0, limit);
    }
    console.log(`🎯 Targeted mode: ${targetedPRs.length} PR(s) to create${limit ? ` (limit: ${limit})` : ''}\n`);

    const tokensByPlatform = {
        github:
            CONFIG.githubToken ||
            process.env.GITHUB_TOKEN ||
            process.env.GH_TOKEN,
        azuredevops: CONFIG.azureDevOpsToken,
    };

    const createdPRs = [];
    for (const pr of targetedPRs) {
        if (!pr.repo || !pr.head || !pr.base) {
            console.warn(`   ⚠️  Skipping invalid PR config: ${JSON.stringify(pr)}`);
            continue;
        }
        const platform = pr.platform || 'github';
        const prToken = tokensByPlatform[platform];
        if (!prToken) {
            console.error(
                `   ❌ Missing token for platform '${platform}' — skipping ${pr.repo}`,
            );
            continue;
        }
        const url = await closeAndCreatePR(pr, prToken);
        if (url) createdPRs.push(url);
    }

    return createdPRs;
}

async function main() {
    console.log('🚀 Kodus PR Creator\n');
    console.log(`🔗 API URL: ${CONFIG.kodusUrl}\n`);

    // Check for targeted PRs config first
    const targetedPRs = await loadTargetedPRs();
    if (targetedPRs) {
        const created = await runTargeted(targetedPRs);
        if (created.length > 0) {
            console.log('\n📋 Created PRs Summary:');
            console.log(`   Total: ${created.length} PR(s)\n`);
            created.forEach((url, i) => console.log(`   ${i + 1}. ${url}`));
        }
        return;
    }

    // Original flow — random PRs from account repos
    const accounts = await loadAccounts();
    const accountsToRun = accounts?.length
        ? accounts
        : [{ email: CONFIG.email, password: CONFIG.password }];

    if (!accountsToRun[0].email || !accountsToRun[0].password) {
        console.error('❌ KODUS_EMAIL and KODUS_PASSWORD are required');
        process.exit(1);
    }

    const allCreatedPRs = [];
    for (const [index, account] of accountsToRun.entries()) {
        console.log(
            `\n🔐 Account ${index + 1}/${accountsToRun.length}: ${account.email}`,
        );
        const created = await runForAccount(account);
        if (created?.length) {
            allCreatedPRs.push(...created);
        }
    }

    if (allCreatedPRs.length > 0 && accountsToRun.length > 1) {
        console.log('\n📌 Overall PR Summary:');
        console.log(`   Total: ${allCreatedPRs.length} PR(s)\n`);
        allCreatedPRs.forEach((url, index) => {
            console.log(`   ${index + 1}. ${url}`);
        });
    }
}

async function login(email, password) {
    console.log('🔐 Logging in...');
    const response = await fetch(`${CONFIG.kodusUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email,
            password,
        }),
    });

    if (!response.ok) {
        const error = await response.text();
        console.error(`❌ Login failed (${response.status}): ${error}`);
        throw new Error(`Login failed: ${response.statusText}`);
    }

    const data = await response.json();

    const accessToken = data.accessToken || data.data?.accessToken;
    if (!accessToken) {
        console.error('📦 Login response:', JSON.stringify(data, null, 2));
        throw new Error('Login failed: no accessToken in response');
    }

    return accessToken;
}

async function getUserInfo(accessToken) {
    if (!accessToken) {
        throw new Error('No access token provided');
    }

    const response = await fetch(`${CONFIG.kodusUrl}/user/info`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
        const error = await response.text();
        console.error(
            `❌ Failed to get user info (${response.status}): ${error}`,
        );
        console.error(
            `🔑 Access token (first 20 chars): ${accessToken.substring(0, 20)}...`,
        );
        throw new Error(`Failed to get user info: ${response.statusText}`);
    }

    const data = await response.json();

    // Se a resposta da QA for wrapper com data/message/etc
    if (data.statusCode !== undefined) {
        return data.data || data.response || data;
    }

    return data;
}

async function getRepositories(accessToken, teamId, organizationId) {
    const url = new URL(`${CONFIG.kodusUrl}/code-management/repositories/org`);
    url.searchParams.set('teamId', teamId);
    if (organizationId) {
        url.searchParams.set('organizationSelected', organizationId);
    }

    const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
        const error = await response.text();
        console.error(
            `❌ Failed to get repositories (${response.status}): ${error}`,
        );
        throw new Error(`Failed to get repositories: ${response.statusText}`);
    }

    const data = await response.json();

    // Se a resposta da QA for wrapper
    const rawData = data.data || data.response || data.repositories || data;

    const repos = Array.isArray(rawData)
        ? rawData
        : rawData?.repositories || [];

    return repos;
}

async function fetchTokensFrom1Password(platformsNeeded = []) {
    if (platformsNeeded.length === 0) {
        platformsNeeded = ['github', 'gitlab', 'bitbucket', 'azuredevOps'];
    }

    const platformEnvTokens = {
        github: CONFIG.githubToken,
        gitlab: CONFIG.gitlabToken,
        bitbucket: CONFIG.bitbucketToken,
        azuredevops: CONFIG.azureDevOpsToken,
    };

    const platformTokenNames = {
        github: CONFIG.opGHToken,
        gitlab: CONFIG.opGLToken,
        bitbucket: CONFIG.opBBToken,
        azuredevops: CONFIG.opADOToken,
    };

    const getTokenFromOp = async (itemName) => {
        try {
            execSync('which op', { stdio: 'ignore' });
        } catch {
            throw new Error(
                '1Password CLI not found. Install from https://developer.1password.com/docs/cli/get-started',
            );
        }

        try {
            const output = execSync(
                `op item get "${itemName}" --fields label=password --reveal`,
                {
                    encoding: 'utf-8',
                },
            ).trim();
            return output;
        } catch {
            return undefined;
        }
    };

    authTokens = {};
    for (const platform of platformsNeeded) {
        console.log(`   🔑 Fetching token for ${platform}...`);

        // Tenta pegar do env primeiro
        let token = platformEnvTokens[platform];

        if (token) {
            console.log(
                `      ✓ Got from env variable ${platform.toUpperCase()}_TOKEN`,
            );
        } else {
            // Fallback para 1Password
            const tokenName = platformTokenNames[platform];
            if (tokenName) {
                token = await getTokenFromOp(tokenName);
                if (token) {
                    console.log(`      ✓ Got from 1Password: ${tokenName}`);
                } else {
                    console.log(`      ✗ ${tokenName} not found in 1Password`);
                }
            }
        }

        authTokens[platform] = token;
    }
}

async function getBranches(platform, token, repo) {
    let repoNameFull = repo.full_name || repo.name;

    if (platform === 'bitbucket') {
        repoNameFull = bitbucketReposCache[repo.name] || repoNameFull;
    }

    const [owner, name] = repoNameFull.split('/');

    try {
        switch (platform) {
            case 'github': {
                const response = await fetch(
                    `https://api.github.com/repos/${owner}/${name}/branches`,
                    {
                        headers: { Authorization: `Bearer ${token}` },
                    },
                );
                if (!response.ok) {
                    console.warn(
                        `      GitHub API error (${response.status}): ${await response.text()}`,
                    );
                    return [];
                }
                const data = await response.json();
                if (!Array.isArray(data)) {
                    console.warn(`      GitHub API returned non-array:`, data);
                    return [];
                }
                return data.map((b) => b.name);
            }
            case 'gitlab': {
                const projectId = encodeURIComponent(repoNameFull);
                const response = await fetch(
                    `https://gitlab.com/api/v4/projects/${projectId}/repository/branches`,
                    {
                        headers: { Authorization: `Bearer ${token}` },
                    },
                );
                if (!response.ok) {
                    console.warn(
                        `      GitLab API error (${response.status}): ${await response.text()}`,
                    );
                    return [];
                }
                const data = await response.json();
                if (!Array.isArray(data)) {
                    console.warn(`      GitLab API returned non-array:`, data);
                    return [];
                }
                return data.map((b) => b.name);
            }
            case 'bitbucket': {
                const response = await fetch(
                    `https://api.bitbucket.org/2.0/repositories/${repoNameFull}/refs/branches`,
                    {
                        headers: {
                            Authorization: getBitbucketAuthHeader(token),
                        },
                    },
                );
                if (!response.ok) {
                    console.warn(
                        `      Bitbucket API error (${response.status}): ${await response.text()}`,
                    );
                    return [];
                }
                const data = await response.json();
                if (!data.values || !Array.isArray(data.values)) {
                    console.warn(
                        `      Bitbucket API returned non-array:`,
                        data,
                    );
                    return [];
                }
                return data.values.map((b) => b.name);
            }
            case 'azuredevops': {
                const { org, project } = getAzureRepoContext(repo);
                console.log(
                    `      🧭 Azure DevOps branches URL: https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo.id}/refs?filterTypes=heads&api-version=6.0`,
                );
                console.log(
                    `      🧾 Azure repo debug: org=${org}, project=${project}, repoName=${repo.name}, repoId=${repo.id}`,
                );
                const response = await fetch(
                    `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo.id}/refs?filterTypes=heads&api-version=6.0`,
                    {
                        headers: {
                            Authorization: getAzureAuthHeader(token),
                        },
                    },
                );
                if (!response.ok) {
                    console.warn(
                        `      Azure DevOps API error (${response.status}) for ${response.url}`,
                    );
                    return [];
                }
                const data = await response.json();
                if (!data.value || !Array.isArray(data.value)) {
                    console.warn(
                        `      Azure DevOps API returned non-array:`,
                        data,
                    );
                    return [];
                }
                return data.value.map((r) => r.name.replace('refs/heads/', ''));
            }
            default:
                return [];
        }
    } catch (error) {
        console.warn(
            `⚠️  Failed to fetch branches for ${repoNameFull}: ${error.message}`,
        );
        return [];
    }
}

async function getOpenPRs(platform, token, repo) {
    let repoNameFull = repo.full_name || repo.name;

    if (platform === 'bitbucket') {
        repoNameFull = bitbucketReposCache[repo.name] || repoNameFull;
    }

    const [owner, name] = repoNameFull.split('/');

    try {
        switch (platform) {
            case 'github': {
                const response = await fetch(
                    `https://api.github.com/repos/${owner}/${name}/pulls?state=open`,
                    {
                        headers: { Authorization: `Bearer ${token}` },
                    },
                );
                if (!response.ok) {
                    console.warn(
                        `      GitHub API error (${response.status}): ${await response.text()}`,
                    );
                    return [];
                }
                const data = await response.json();
                if (!Array.isArray(data)) {
                    console.warn(`      GitHub API returned non-array:`, data);
                    return [];
                }
                return data.map((pr) => pr.head.ref);
            }
            case 'gitlab': {
                const projectId = encodeURIComponent(repoNameFull);
                const response = await fetch(
                    `https://gitlab.com/api/v4/projects/${projectId}/merge_requests?state=opened`,
                    {
                        headers: { Authorization: `Bearer ${token}` },
                    },
                );
                if (!response.ok) {
                    console.warn(
                        `      GitLab API error (${response.status}): ${await response.text()}`,
                    );
                    return [];
                }
                const data = await response.json();
                if (!Array.isArray(data)) {
                    console.warn(`      GitLab API returned non-array:`, data);
                    return [];
                }
                return data.map((mr) => mr.source_branch);
            }
            case 'bitbucket': {
                const prs = [];
                let url = `https://api.bitbucket.org/2.0/repositories/${repoNameFull}/pullrequests?state=OPEN`;
                do {
                    const response = await fetch(url, {
                        headers: {
                            Authorization: getBitbucketAuthHeader(token),
                        },
                    });
                    if (!response.ok) {
                        console.warn(
                            `      Bitbucket API error (${response.status}): ${await response.text()}`,
                        );
                        return prs.map((pr) => pr.source.branch.name);
                    }
                    const data = await response.json();
                    if (!data.values || !Array.isArray(data.values)) {
                        console.warn(
                            `      Bitbucket API returned non-array:`,
                            data,
                        );
                        return prs.map((pr) => pr.source.branch.name);
                    }
                    prs.push(...data.values);
                    url = data.next;
                } while (url);
                return prs.map((pr) => pr.source.branch.name);
            }
            case 'azuredevops': {
                const { org, project } = getAzureRepoContext(repo);
                console.log(
                    `      🧭 Azure DevOps PRs URL: https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo.id}/pullrequests?status=active&api-version=6.0`,
                );
                console.log(
                    `      🧾 Azure repo debug: org=${org}, project=${project}, repoName=${repo.name}, repoId=${repo.id}`,
                );
                const response = await fetch(
                    `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo.id}/pullrequests?status=active&api-version=6.0`,
                    {
                        headers: { Authorization: getAzureAuthHeader(token) },
                    },
                );
                if (!response.ok) {
                    console.warn(
                        `      Azure DevOps API error (${response.status}) for ${response.url}`,
                    );
                    return [];
                }
                const data = await response.json();
                if (!data.value || !Array.isArray(data.value)) {
                    console.warn(
                        `      Azure DevOps API returned non-array:`,
                        data,
                    );
                    return [];
                }
                return data.value.map((pr) =>
                    pr.sourceRefName.replace('refs/heads/', ''),
                );
            }
            default:
                return [];
        }
    } catch (error) {
        console.warn(
            `⚠️  Failed to fetch PRs for ${repoNameFull}: ${error.message}`,
        );
        return [];
    }
}

function inferPlatformFromUrl(url) {
    if (!url) return null;

    try {
        const parsedUrl = new URL(url);
        const hostname = parsedUrl.hostname.toLowerCase();

        // Use exact hostname matching to prevent bypass attacks
        // e.g., "evil-github.com" should not match "github.com"
        if (hostname === 'github.com' || hostname.endsWith('.github.com')) {
            return 'github';
        }
        if (hostname === 'gitlab.com' || hostname.endsWith('.gitlab.com')) {
            return 'gitlab';
        }
        if (hostname === 'bitbucket.org' || hostname.endsWith('.bitbucket.org')) {
            return 'bitbucket';
        }
        if (
            hostname === 'dev.azure.com' ||
            hostname.endsWith('.dev.azure.com') ||
            hostname === 'visualstudio.com' ||
            hostname.endsWith('.visualstudio.com')
        ) {
            return 'azuredevops';
        }

        return null;
    } catch {
        // Invalid URL format
        return null;
    }
}

function getAzureRepoContext(repo) {
    const rawUrl = repo.http_url || repo.ssh_url || repo.repoUrl || '';
    if (rawUrl) {
        try {
            const parsed = new URL(rawUrl);
            if (parsed.hostname.endsWith('dev.azure.com')) {
                const parts = parsed.pathname.split('/').filter(Boolean);
                const org = parts[0];
                const project = parts[1];
                const repoName = parts[3];
                if (org && project && repoName) {
                    return { org, project, repoName };
                }
            }
            if (parsed.hostname.endsWith('visualstudio.com')) {
                const org = parsed.hostname.split('.')[0];
                const parts = parsed.pathname.split('/').filter(Boolean);
                const project = parts[0];
                const repoName = parts[2];
                if (org && project && repoName) {
                    return { org, project, repoName };
                }
            }
        } catch {
            // ignore url parse errors
        }
    }

    const fallbackFullName = repo.full_name || repo.name || '';
    const [org, project] = fallbackFullName.split('/');
    return {
        org: org || undefined,
        project: project || undefined,
        repoName: repo.name || fallbackFullName,
    };
}

function getAzureRepoContextFromPr(pr) {
    return getAzureRepoContext({
        http_url: pr.repoUrl,
        full_name: pr.repoName,
        name: pr.repoName,
    });
}

function mapIntegrationType(type) {
    if (!type) return null;

    const mapping = {
        github: 'github',
        gitlab: 'gitlab',
        bitbucket: 'bitbucket',
        azure_repos: 'azuredevops',
    };
    return mapping[type] || type.toLowerCase().replace('_', '');
}

async function detectFork(platform, token, repo) {
    let repoNameFull = repo.full_name || repo.name;

    if (platform === 'bitbucket') {
        repoNameFull = bitbucketReposCache[repo.name] || repoNameFull;
    }

    const [owner, name] = repoNameFull.split('/');

    try {
        switch (platform) {
            case 'github': {
                const response = await fetch(
                    `https://api.github.com/repos/${owner}/${name}`,
                    {
                        headers: { Authorization: `Bearer ${token}` },
                    },
                );
                const data = await response.json();
                return {
                    isFork: data.fork === true,
                    upstream: data.parent
                        ? {
                              owner: data.parent.owner.login,
                              repo: data.parent.name,
                              defaultBranch: data.parent.default_branch,
                          }
                        : null,
                };
            }
            case 'gitlab': {
                const projectId = encodeURIComponent(repoNameFull);
                const response = await fetch(
                    `https://gitlab.com/api/v4/projects/${projectId}`,
                    {
                        headers: { Authorization: `Bearer ${token}` },
                    },
                );
                const data = await response.json();
                return {
                    isFork: data.forked_from_project !== null,
                    upstream: data.forked_from_project
                        ? {
                              projectId: data.forked_from_project.id,
                              defaultBranch: data.default_branch,
                          }
                        : null,
                };
            }
            case 'bitbucket': {
                const response = await fetch(
                    `https://api.bitbucket.org/2.0/repositories/${repoNameFull}`,
                    {
                        headers: {
                            Authorization: getBitbucketAuthHeader(token),
                        },
                    },
                );
                const data = await response.json();
                return {
                    isFork: data.parent !== null && data.parent !== undefined,
                    upstream: data.parent
                        ? {
                              owner: data.parent.slug,
                              repo: data.parent.name,
                          }
                        : null,
                };
            }
            case 'azuredevops': {
                return {
                    isFork: false,
                    upstream: null,
                };
            }
            default:
                return { isFork: false, upstream: null };
        }
    } catch (error) {
        console.warn(`⚠️  Failed to detect fork for ${repoNameFull}: ${error}`);
        return { isFork: false, upstream: null };
    }
}

async function syncForkWithUpstream(platform, token, repo, forkInfo) {
    let repoNameFull = repo.full_name || repo.name;

    if (platform === 'bitbucket') {
        repoNameFull = bitbucketReposCache[repo.name] || repoNameFull;
    }

    const [owner, name] = repoNameFull.split('/');

    try {
        switch (platform) {
            case 'github': {
                console.log(
                    `      🔄 Syncing GitHub fork ${repoNameFull} with upstream...`,
                );
                const response = await fetch(
                    `https://api.github.com/repos/${owner}/${name}/merge-upstream`,
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            branch: repo.default_branch || 'main',
                        }),
                    },
                );
                if (response.status === 405) {
                    console.log(`      ℹ️  Up to date (no changes to sync)`);
                } else if (!response.ok) {
                    const error = await response.text();
                    console.warn(`      ⚠️  Sync warning: ${error}`);
                } else {
                    console.log(`      ✓ Fork synced successfully`);
                }
                break;
            }
            case 'gitlab': {
                const projectId = encodeURIComponent(
                    repo.integration?.platformRepositoryId ||
                        repo.integration?.repositoryId,
                );
                const upstreamId = encodeURIComponent(
                    forkInfo.upstream?.projectId,
                );
                console.log(
                    `      🔄 Syncing GitLab fork with upstream project ${upstreamId}...`,
                );
                const response = await fetch(
                    `https://gitlab.com/api/v4/projects/${projectId}/remote`,
                    {
                        method: 'PUT',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            url: `https://gitlab.com/${forkInfo.upstream?.projectId}`,
                            mirror: true,
                        }),
                    },
                );
                console.log(`      ✓ GitLab fork sync initiated`);
                break;
            }
            case 'bitbucket': {
                console.log(
                    `      🔄 Syncing Bitbucket fork ${repoNameFull}...`,
                );

                const branches = await fetch(
                    `https://api.bitbucket.org/2.0/repositories/${repoNameFull}/refs/branches`,
                    {
                        headers: {
                            Authorization: getBitbucketAuthHeader(token),
                        },
                    },
                );
                const branchesData = await branches.json();

                if (
                    !branchesData.values?.some(
                        (b) => b.name === (repo.default_branch || 'main'),
                    )
                ) {
                    console.log(
                        `      ⚠️  Main branch not found, cannot sync automatically`,
                    );
                } else {
                    console.log(
                        `      ✓ Bitbucket fork ready (manual sync available via UI)`,
                    );
                }
                break;
            }
            case 'azuredevops': {
                console.log(
                    `      ⚠️  Azure DevOps does not support automatic fork sync via API`,
                );
                break;
            }
        }
    } catch (error) {
        console.warn(`      ⚠️  Failed to sync fork: ${error}`);
    }
}

async function closeAllPRs(repo, platform, token) {
    let repoNameFull = repo.full_name || repo.name;

    if (platform === 'bitbucket') {
        repoNameFull = bitbucketReposCache[repo.name] || repoNameFull;
    }

    const [owner, name] = repoNameFull.split('/');

    try {
        switch (platform) {
            case 'github': {
                console.log(`   🗑️  Closing open PRs in ${repoNameFull}...`);
                const response = await fetch(
                    `https://api.github.com/repos/${owner}/${name}/pulls?state=open`,
                    {
                        headers: { Authorization: `Bearer ${token}` },
                    },
                );
                if (!response.ok) {
                    console.warn(
                        `      Failed to list PRs (${response.status}) for ${response.url}`,
                    );
                    return [];
                }
                const prs = await response.json();
                if (!Array.isArray(prs)) {
                    console.warn(`      GitHub API returned non-array:`, prs);
                    return [];
                }

                const closed = [];
                for (const pr of prs) {
                    const closeResponse = await fetch(
                        `https://api.github.com/repos/${owner}/${name}/pulls/${pr.number}`,
                        {
                            method: 'PATCH',
                            headers: {
                                'Authorization': `Bearer ${token}`,
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ state: 'closed' }),
                        },
                    );
                    if (closeResponse.ok) {
                        closed.push(pr.number);
                    } else {
                        console.warn(`      Failed to close PR #${pr.number}`);
                    }
                }
                console.log(`      ✓ Closed ${closed.length} PRs`);
                return closed;
            }
            case 'gitlab': {
                console.log(`   🗑️  Closing open MRs in ${repoNameFull}...`);
                const projectId = encodeURIComponent(repoNameFull);
                const response = await fetch(
                    `https://gitlab.com/api/v4/projects/${projectId}/merge_requests?state=opened`,
                    {
                        headers: { Authorization: `Bearer ${token}` },
                    },
                );
                if (!response.ok) {
                    console.warn(
                        `      Failed to list MRs: ${response.status}`,
                    );
                    return [];
                }
                const mrs = await response.json();
                if (!Array.isArray(mrs)) {
                    console.warn(`      GitLab API returned non-array:`, mrs);
                    return [];
                }

                const closed = [];
                for (const mr of mrs) {
                    const closeResponse = await fetch(
                        `https://gitlab.com/api/v4/projects/${projectId}/merge_requests/${mr.iid}`,
                        {
                            method: 'PUT',
                            headers: {
                                'Authorization': `Bearer ${token}`,
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ state_event: 'close' }),
                        },
                    );
                    if (closeResponse.ok) {
                        closed.push(mr.iid);
                    } else {
                        console.warn(`      Failed to close MR !${mr.iid}`);
                    }
                }
                console.log(`      ✓ Closed ${closed.length} MRs`);
                return closed;
            }
            case 'bitbucket': {
                console.log(`   🗑️  Closing open PRs in ${repoNameFull}...`);
                const prs = [];
                let url = `https://api.bitbucket.org/2.0/repositories/${repoNameFull}/pullrequests?state=OPEN`;
                do {
                    const response = await fetch(url, {
                        headers: {
                            Authorization: getBitbucketAuthHeader(token),
                        },
                    });
                    if (!response.ok) {
                        console.warn(
                            `      Failed to list PRs: ${response.status}`,
                        );
                        return [];
                    }
                    const data = await response.json();
                    if (!data.values || !Array.isArray(data.values)) {
                        console.warn(
                            `      Bitbucket API returned non-array:`,
                            data,
                        );
                        return prs;
                    }
                    prs.push(...data.values);
                    url = data.next;
                } while (url);

                const closed = [];
                for (const pr of prs) {
                    const closeResponse = await fetch(
                        `https://api.bitbucket.org/2.0/repositories/${repoNameFull}/pullrequests/${pr.id}`,
                        {
                            method: 'PUT',
                            headers: {
                                'Authorization': getBitbucketAuthHeader(token),
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ state: 'DECLINED' }),
                        },
                    );
                    if (closeResponse.ok) {
                        closed.push(pr.id);
                    } else {
                        console.warn(`      Failed to close PR #${pr.id}`);
                    }
                }
                console.log(`      ✓ Closed ${closed.length} PRs`);
                return closed;
            }
            case 'azuredevops': {
                console.log(`   🗑️  Closing open PRs in ${repoNameFull}...`);
                const { org, project } = getAzureRepoContext(repo);
                const response = await fetch(
                    `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo.id}/pullrequests?status=active&api-version=6.0`,
                    {
                        headers: { Authorization: getAzureAuthHeader(token) },
                    },
                );
                if (!response.ok) {
                    console.warn(
                        `      Failed to list PRs: ${response.status}`,
                    );
                    return [];
                }
                const data = await response.json();
                if (!data.value || !Array.isArray(data.value)) {
                    console.warn(
                        `      Azure DevOps API returned non-array:`,
                        data,
                    );
                    return [];
                }

                const closed = [];
                for (const pr of data.value) {
                    const closeResponse = await fetch(
                        `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo.id}/pullrequests/${pr.pullRequestId}?api-version=6.0`,
                        {
                            method: 'PATCH',
                            headers: {
                                'Authorization': getAzureAuthHeader(token),
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ status: 'abandoned' }),
                        },
                    );
                    if (closeResponse.ok) {
                        closed.push(pr.pullRequestId);
                    } else {
                        console.warn(
                            `      Failed to close PR #${pr.pullRequestId}`,
                        );
                    }
                }
                console.log(`      ✓ Closed ${closed.length} PRs`);
                return closed;
            }
            default:
                return [];
        }
    } catch (error) {
        console.warn(
            `❌ Failed to close PRs for ${repoNameFull}: ${error.message}`,
        );
        return [];
    }
}

async function createPR(pr, token) {
    const prTitle = `Kodus Test PR - ${Date.now()}`;
    const prBody = 'Test PR created by Kodus PR Creator script';

    try {
        switch (pr.platform) {
            case 'github': {
                const [owner, name] = pr.repoName.split('/');
                console.log(
                    `📝 Creating GitHub PR for ${pr.repoName}: ${pr.sourceBranch} → ${pr.targetBranch}`,
                );
                const response = await fetch(
                    `https://api.github.com/repos/${owner}/${name}/pulls`,
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            title: prTitle,
                            body: prBody,
                            head: pr.sourceBranch,
                            base: pr.targetBranch,
                        }),
                    },
                );
                if (!response.ok) throw new Error(await response.text());
                const data = await response.json();
                console.log(`   ✅ PR created: ${data.html_url}`);
                await new Promise((resolve) => setTimeout(resolve, 2000));
                return data.html_url;
            }
            case 'gitlab': {
                const repoId = encodeURIComponent(pr.repoName);
                console.log(
                    `📝 Creating GitLab MR for ${pr.repoName}: ${pr.sourceBranch} → ${pr.targetBranch}`,
                );
                const response = await fetch(
                    `https://gitlab.com/api/v4/projects/${repoId}/merge_requests`,
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            title: prTitle,
                            description: prBody,
                            source_branch: pr.sourceBranch,
                            target_branch: pr.targetBranch,
                            remove_source_branch: false,
                        }),
                    },
                );
                if (!response.ok) throw new Error(await response.text());
                const data = await response.json();
                console.log(`   ✅ MR created: ${data.web_url}`);
                await new Promise((resolve) => setTimeout(resolve, 2000));
                return data.web_url;
            }
            case 'bitbucket': {
                let repoNameFull = pr.repoName;
                if (repoNameFull.split('/').length === 1) {
                    repoNameFull =
                        bitbucketReposCache[repoNameFull] || repoNameFull;
                }
                console.log(
                    `📝 Creating Bitbucket PR for ${repoNameFull}: ${pr.sourceBranch} → ${pr.targetBranch}`,
                );
                const response = await fetch(
                    `https://api.bitbucket.org/2.0/repositories/${repoNameFull}/pullrequests`,
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': getBitbucketAuthHeader(token),
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            title: prTitle,
                            description: prBody,
                            source: { branch: { name: pr.sourceBranch } },
                            destination: { branch: { name: pr.targetBranch } },
                        }),
                    },
                );
                if (!response.ok) throw new Error(await response.text());
                const data = await response.json();
                console.log(`   ✅ PR created: ${data.links.html.href}`);
                await new Promise((resolve) => setTimeout(resolve, 2000));
                return data.links.html.href;
            }
            case 'azuredevops': {
                const { org, project } = getAzureRepoContextFromPr(pr);
                const response = await fetch(
                    `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${pr.repoId}/pullrequests?api-version=6.0`,
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': getAzureAuthHeader(token),
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            title: prTitle,
                            description: prBody,
                            sourceRefName: `refs/heads/${pr.sourceBranch}`,
                            targetRefName: `refs/heads/${pr.targetBranch}`,
                        }),
                    },
                );
                if (!response.ok) throw new Error(await response.text());
                const data = await response.json();
                const prUrl =
                    data?._links?.web?.href ||
                    data?.url ||
                    (data?.pullRequestId &&
                        `https://dev.azure.com/${org}/${project}/_git/${data?.repository?.name || pr.repoName}/pullrequest/${data.pullRequestId}`);
                if (prUrl) {
                    console.log(`   ✅ PR created: ${prUrl}`);
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                    return prUrl;
                }
                console.log(`   ✅ PR created (no URL in response)`);
                await new Promise((resolve) => setTimeout(resolve, 2000));
                return undefined;
            }
        }
    } catch (error) {
        console.error(`   ❌ Failed to create PR: ${error}`);
    }
}

main().catch(console.error);
