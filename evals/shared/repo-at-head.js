// A snapshot's repository at its frozen head, answered where the Git provider
// would answer production's repository reader: the file list
// (getRepositoryAllFiles) and one file (getRepositoryContentFile). Read from
// GitHub at the head SHA, never at a branch that moved since, and cached on
// disk so a rerun reads nothing twice. A snapshot without a repository and
// head SHA (a scripted case) has no repository to read.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE = path.join(os.tmpdir(), 'kodus-eval-repo-at-head');

async function github(url, raw = false) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const response = await fetch(url, {
        headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            'accept': raw
                ? 'application/vnd.github.raw'
                : 'application/vnd.github+json',
            'user-agent': 'kodus-evals',
        },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitHub ${response.status} for ${url}`);
    return raw ? response.text() : response.json();
}

function cached(key, read) {
    const file = path.join(
        CACHE,
        crypto.createHash('sha256').update(key).digest('hex'),
    );
    if (fs.existsSync(file))
        return Promise.resolve(JSON.parse(fs.readFileSync(file, 'utf8')).value);
    return read().then((value) => {
        fs.mkdirSync(CACHE, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ value: value ?? null }));
        return value ?? null;
    });
}

function repoAtHead(item) {
    const repository = item.repository;
    const sha = item.headSha;
    if (!repository?.includes('/') || !/^[0-9a-f]{40}$/.test(sha ?? '')) {
        return {
            getRepositoryAllFiles: async () => [],
            getRepositoryContentFile: async () => null,
        };
    }
    const api = `https://api.github.com/repos/${repository}`;
    return {
        getRepositoryAllFiles: async () =>
            (
                (await cached(`tree:${repository}@${sha}`, async () =>
                    (
                        (await github(`${api}/git/trees/${sha}?recursive=1`))
                            ?.tree ?? []
                    )
                        .filter((entry) => entry.type === 'blob')
                        .map((entry) => entry.path),
                )) ?? []
            ).map((p) => ({ path: p })),
        getRepositoryContentFile: async ({ file }) => {
            const text = await cached(
                `file:${repository}@${sha}:${file?.filename}`,
                () =>
                    github(
                        `${api}/contents/${encodeURI(file?.filename ?? '')}?ref=${sha}`,
                        true,
                    ),
            );
            return typeof text === 'string'
                ? {
                      data: {
                          content: Buffer.from(text).toString('base64'),
                          encoding: 'base64',
                      },
                  }
                : null;
        },
    };
}

module.exports = { repoAtHead };
