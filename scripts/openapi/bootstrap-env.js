#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const envPath = path.join(root, 'docs', 'openapi.postman_environment.json');

if (!fs.existsSync(envPath)) {
    console.error(
        `Missing env file at ${envPath}. Create from docs/openapi.postman_environment.example.json`,
    );
    process.exit(1);
}

const env = JSON.parse(fs.readFileSync(envPath, 'utf8'));
const values = Array.isArray(env.values) ? env.values : [];

const getVal = (key) => values.find((v) => v.key === key)?.value || '';
const setVal = (key, value) => {
    if (value === undefined || value === null || value === '') return;
    const entry = values.find((v) => v.key === key);
    if (entry) {
        entry.value = value;
    } else {
        values.push({ key, value, enabled: true });
    }
};

const baseUrl = getVal('baseUrl') || 'http://localhost:3001';
const email = getVal('email');
const password = getVal('password');

if (!email || !password) {
    console.error(
        'Missing email/password in env. Fill docs/openapi.postman_environment.json first.',
    );
    process.exit(1);
}

const now = new Date();
const startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
setVal('startDate', getVal('startDate') || startDate.toISOString());
setVal('endDate', getVal('endDate') || now.toISOString());
setVal('beforeAt', getVal('beforeAt') || now.toISOString());
setVal('afterAt', getVal('afterAt') || startDate.toISOString());
setVal('page', getVal('page') || '1');
setVal('perPage', getVal('perPage') || '20');
setVal('limit', getVal('limit') || '20');
setVal('skip', getVal('skip') || '0');
setVal('window', getVal('window') || '15');
setVal('hours', getVal('hours') || '24');
setVal('organizationSelected', getVal('organizationSelected') || 'true');
setVal('isSelected', getVal('isSelected') || 'true');
setVal('configType', getVal('configType') || 'main');
setVal('protocol', getVal('protocol') || 'saml');
setVal('active', getVal('active') || 'true');
setVal('codeReviewVersion', getVal('codeReviewVersion') || 'legacy');
setVal(
    'integrationCategory',
    getVal('integrationCategory') || 'code_management',
);
setVal('model', getVal('model') || 'gpt-4');
setVal('models', getVal('models') || 'gpt-4');
setVal('timezone', getVal('timezone') || 'UTC');
setVal('developer', getVal('developer') || '');
setVal('byok', getVal('byok') || '');
setVal('branch', getVal('branch') || '');
setVal('author', getVal('author') || '');
setVal('state', getVal('state') || '');
setVal('domain', getVal('domain') || 'example.com');
setVal('q', getVal('q') || '');
setVal('number', getVal('number') || '');
setVal(
    'repositoryIds',
    getVal('repositoryIds') || getVal('repositoryId') || '',
);
setVal('hasSentSuggestions', getVal('hasSentSuggestions') || 'false');
setVal('pullRequestTitle', getVal('pullRequestTitle') || '');
setVal(
    'pullRequestNumber',
    getVal('pullRequestNumber') || getVal('prNumber') || '',
);
setVal('format', getVal('format') || 'json');
setVal('severity', getVal('severity') || 'high');
setVal('category', getVal('category') || 'bug');
setVal('tags', getVal('tags') || '');
setVal('buckets', getVal('buckets') || '');
setVal('plug_and_play', getVal('plug_and_play') || 'false');
setVal('language', getVal('language') || 'JSTS');
setVal('sampleSize', getVal('sampleSize') || '5');
setVal('userEmail', getVal('userEmail') || getVal('email') || '');

const request = async (method, url, { headers, body } = {}) => {
    const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        json = text;
    }
    return { status: res.status, json, headers: res.headers };
};

const unwrap = (payload) => {
    if (!payload) return payload;
    if (payload.data !== undefined) return payload.data;
    return payload;
};

const run = async () => {
    const authRes = await request('POST', `${baseUrl}/auth/login`, {
        headers: { 'Content-Type': 'application/json' },
        body: { email, password },
    });
    const authPayload = authRes.json || {};
    const accessToken =
        authPayload.accessToken ||
        (authPayload.data && authPayload.data.accessToken);
    const refreshToken =
        authPayload.refreshToken ||
        (authPayload.data && authPayload.data.refreshToken);

    if (accessToken) {
        setVal('jwt', accessToken);
        setVal('bearerToken', accessToken);
    }
    if (refreshToken) {
        setVal('refreshToken', refreshToken);
    }

    const authHeader = accessToken
        ? { Authorization: `Bearer ${accessToken}` }
        : {};

    const userInfoRes = await request('GET', `${baseUrl}/user/info`, {
        headers: { ...authHeader, Accept: 'application/json' },
    });
    const userInfo = unwrap(userInfoRes.json);
    if (userInfo?.uuid) setVal('userId', userInfo.uuid);
    if (userInfo?.organization?.uuid)
        setVal('organizationId', userInfo.organization.uuid);

    let teamId = getVal('teamId') || userInfo?.teamMember?.[0]?.team?.uuid;
    if (!teamId) {
        const teamRes = await request('GET', `${baseUrl}/team`, {
            headers: { ...authHeader, Accept: 'application/json' },
        });
        const teams = unwrap(teamRes.json);
        if (Array.isArray(teams) && teams[0]?.uuid) teamId = teams[0].uuid;
    }
    if (teamId) setVal('teamId', teamId);

    let repositoryId = getVal('repositoryId');
    let repositoryName = getVal('repositoryName');
    if (teamId && (!repositoryId || !repositoryName)) {
        const repoUrl = new URL(`${baseUrl}/code-management/repositories/org`);
        repoUrl.searchParams.set('teamId', teamId);
        repoUrl.searchParams.set('organizationSelected', 'true');
        const repoRes = await request('GET', repoUrl.toString(), {
            headers: { ...authHeader, Accept: 'application/json' },
        });
        const repoPayload = unwrap(repoRes.json);
        const repoList = Array.isArray(repoPayload)
            ? repoPayload
            : Array.isArray(repoPayload?.data)
              ? repoPayload.data
              : [];
        const selected = repoList.find((r) => r.selected) || repoList[0];
        if (selected?.id) repositoryId = selected.id;
        if (selected?.name) repositoryName = selected.name;
        if (!getVal('provider') && selected?.platform)
            setVal('provider', selected.platform);
    }
    if (repositoryId) setVal('repositoryId', repositoryId);
    if (repositoryName) setVal('repositoryName', repositoryName);
    if (!getVal('provider')) setVal('provider', 'github');

    if (teamId && (!getVal('prNumber') || !getVal('prUrl'))) {
        const prsUrl = new URL(`${baseUrl}/code-management/get-prs`);
        prsUrl.searchParams.set('teamId', teamId);
        const prsRes = await request('GET', prsUrl.toString(), {
            headers: { ...authHeader, Accept: 'application/json' },
        });
        const prsPayload = unwrap(prsRes.json);
        const prsList = Array.isArray(prsPayload) ? prsPayload : [];
        const pr = prsList[0];
        if (pr?.pull_number) setVal('prNumber', String(pr.pull_number));
        if (pr?.url) setVal('prUrl', pr.url);
        if (!repositoryId && pr?.repository?.id) {
            repositoryId = pr.repository.id;
            setVal('repositoryId', repositoryId);
        }
        if (!repositoryName && pr?.repository?.name) {
            repositoryName = pr.repository.name;
            setVal('repositoryName', repositoryName);
        }
    }

    if (!getVal('ruleId')) {
        const rulesRes = await request(
            'GET',
            `${baseUrl}/kody-rules/find-by-organization-id`,
            {
                headers: { ...authHeader, Accept: 'application/json' },
            },
        );
        const rulesPayload = unwrap(rulesRes.json);
        const rules = rulesPayload?._rules || [];
        if (rules[0]?.uuid) setVal('ruleId', rules[0].uuid);
    }

    if (teamId && !getVal('teamKey')) {
        const keyName = `openapi-bootstrap-${Date.now()}`;
        const keyRes = await request(
            'POST',
            `${baseUrl}/teams/${teamId}/cli-keys`,
            {
                headers: { ...authHeader, 'Content-Type': 'application/json' },
                body: { name: keyName },
            },
        );
        const keyPayload = unwrap(keyRes.json);
        if (keyPayload?.key) setVal('teamKey', keyPayload.key);

        const listRes = await request(
            'GET',
            `${baseUrl}/teams/${teamId}/cli-keys`,
            {
                headers: { ...authHeader, Accept: 'application/json' },
            },
        );
        const listPayload = unwrap(listRes.json);
        if (Array.isArray(listPayload)) {
            const found =
                listPayload.find((k) => k.name === keyName) || listPayload[0];
            if (found?.uuid) setVal('keyId', found.uuid);
        }
    }

    if (teamId && !getVal('targetUserId')) {
        const membersUrl = new URL(`${baseUrl}/team-members`);
        membersUrl.searchParams.set('teamId', teamId);
        const membersRes = await request('GET', membersUrl.toString(), {
            headers: { ...authHeader, Accept: 'application/json' },
        });
        const membersPayload = unwrap(membersRes.json);
        const members = membersPayload?.members || [];
        const currentUserId = getVal('userId');
        const candidate =
            members.find((m) => m.uuid && m.uuid !== currentUserId) ||
            members.find((m) => m.uuid);
        if (candidate?.uuid) setVal('targetUserId', candidate.uuid);
    }

    if (teamId && repositoryId && !getVal('directoryId')) {
        const treeUrl = new URL(
            `${baseUrl}/code-management/get-repository-tree-by-directory`,
        );
        treeUrl.searchParams.set('teamId', teamId);
        treeUrl.searchParams.set('repositoryId', repositoryId);
        treeUrl.searchParams.set('directoryPath', '');
        treeUrl.searchParams.set('useCache', 'true');
        const treeRes = await request('GET', treeUrl.toString(), {
            headers: { ...authHeader, Accept: 'application/json' },
        });
        const treePayload = unwrap(treeRes.json);
        const dirs = treePayload?.directories || [];
        if (dirs[0]?.id) setVal('directoryId', dirs[0].id);
    }

    if (
        teamId &&
        repositoryId &&
        getVal('prNumber') &&
        !getVal('correlationId')
    ) {
        const dryRunRes = await request('POST', `${baseUrl}/dry-run/execute`, {
            headers: { ...authHeader, 'Content-Type': 'application/json' },
            body: {
                teamId,
                repositoryId,
                prNumber: Number(getVal('prNumber')),
            },
        });
        const dryRunPayload = unwrap(dryRunRes.json);
        if (typeof dryRunPayload === 'string')
            setVal('correlationId', dryRunPayload);
    }

    fs.writeFileSync(envPath, JSON.stringify(env, null, 2));
    console.log(`Environment updated at ${envPath}`);
};

run().catch((error) => {
    console.error('Failed to bootstrap env:', error);
    process.exit(1);
});
