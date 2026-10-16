// GitHub's REST API for one repository and one pull request, answered from the
// pull request's git remote (pr-remote.js). Production's GithubService talks to
// it as to a GitHub Enterprise host (`<host>/api/v3`, a token integration), so
// the service's own requests and the mapping it does on GitHub's answers run as
// they do for a customer; what GitHub would answer is read from git.
//
// Only the routes GithubService reaches for the Kodus MCP tools are served, in
// GitHub's shapes. Any other route answers 404, as GitHub does for a path it
// does not have, and is kept in `misses` so a run can say what went unserved.
const http = require('http');

class NotFound {
    constructor(payload) {
        this.payload = payload;
    }
}

function startGithubRest({ pr, owner, repository, author = { login: 'dev', id: 1 } }) {
    const misses = [];
    const server = http.createServer((req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost');
            const answer = route(req.method, url);
            if (answer === undefined) {
                misses.push(`${req.method} ${url.pathname}`);
                return send(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest', status: '404' });
            }
            return answer instanceof NotFound ? send(res, 404, answer.payload) : send(res, 200, answer);
        } catch (error) {
            return send(res, 500, { message: String(error.message || error) });
        }
    });
    let origin;

    const send = (res, status, body) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
    };
    const git = (...a) => pr.git(...a);
    const exists = (ref, file) => {
        try {
            return git('cat-file', '-t', `${ref}:${file}`);
        } catch {
            return null;
        }
    };
    const refOf = (ref) => (ref === pr.head ? `refs/pull/${pr.number}/head` : ref || pr.base);

    const repo = () => ({
        id: Number(repository.id),
        node_id: `R_${repository.id}`,
        name: repository.name,
        full_name: `${owner}/${repository.name}`,
        private: true,
        visibility: 'private',
        archived: false,
        owner: { login: owner, id: 9001, type: 'Organization', avatar_url: `${origin}/avatars/${owner}` },
        html_url: `${origin}/${owner}/${repository.name}`,
        default_branch: pr.base,
        language: 'TypeScript',
        created_at: pr.date,
        updated_at: pr.date,
        pushed_at: pr.date,
    });
    const user = () => ({ login: author.login, id: author.id, type: 'User', avatar_url: `${origin}/avatars/${author.login}` });
    const pull = () => ({
        id: 70000 + pr.number,
        node_id: `PR_${pr.number}`,
        number: pr.number,
        state: 'open',
        draft: false,
        merged: false,
        title: pr.message,
        body: '',
        html_url: `${origin}/${owner}/${repository.name}/pull/${pr.number}`,
        user: user(),
        requested_reviewers: [],
        head: { ref: pr.head, sha: pr.headSha, label: `${owner}:${pr.head}`, repo: repo() },
        base: { ref: pr.base, sha: pr.baseSha, label: `${owner}:${pr.base}`, repo: repo() },
        created_at: pr.date,
        updated_at: pr.date,
        closed_at: null,
        merged_at: null,
    });
    const files = () =>
        git('diff', '--name-status', pr.baseSha, pr.headSha)
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                const [code, filename] = line.split('\t');
                const [additions, deletions] = git('diff', '--numstat', pr.baseSha, pr.headSha, '--', filename).split('\t').map(Number);
                // GitHub's patch is the diff from the first hunk on, without
                // the file headers.
                const diff = git('diff', pr.baseSha, pr.headSha, '--', filename);
                const status = { A: 'added', M: 'modified', D: 'removed' }[code[0]] || 'modified';
                return {
                    sha: status === 'removed' ? null : git('rev-parse', `${pr.headSha}:${filename}`),
                    filename,
                    status,
                    additions,
                    deletions,
                    changes: additions + deletions,
                    patch: diff.slice(diff.indexOf('@@')),
                };
            });
    const commits = (ref) =>
        git('log', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%B%x1e', refOf(ref))
            .split('\x1e')
            .map((entry) => entry.trim())
            .filter(Boolean)
            .map((entry) => {
                const [sha, parents, name, email, date, message] = entry.split('\x1f');
                return {
                    sha,
                    commit: { author: { name, email, date }, committer: { name, email, date }, message: message.trim() },
                    author: user(),
                    committer: user(),
                    parents: parents.split(' ').filter(Boolean).map((p) => ({ sha: p })),
                    html_url: `${origin}/${owner}/${repository.name}/commit/${sha}`,
                };
            });
    const content = (ref, file) => {
        const kind = exists(ref, file);
        if (kind === 'tree') {
            return git('ls-tree', `${ref}:${file}`)
                .split('\n')
                .filter(Boolean)
                .map((line) => {
                    const [meta, name] = line.split('\t');
                    const [, type, sha] = meta.split(' ');
                    return { type: type === 'tree' ? 'dir' : 'file', name, path: `${file}/${name}`, sha };
                });
        }
        if (kind !== 'blob') return new NotFound({ message: 'Not Found', documentation_url: 'https://docs.github.com/rest/repos/contents#get-repository-content', status: '404' });
        const bytes = pr.read(`${ref}:${file}`);
        return {
            type: 'file',
            encoding: 'base64',
            size: bytes.length,
            name: file.split('/').pop(),
            path: file,
            sha: git('rev-parse', `${ref}:${file}`),
            // GitHub wraps the base64 at 60 characters.
            content: bytes.toString('base64').replace(/(.{60})/g, '$1\n'),
            html_url: `${origin}/${owner}/${repository.name}/blob/${ref}/${file}`,
        };
    };
    const tree = (ref) => ({
        sha: git('rev-parse', `${ref}^{tree}`),
        truncated: false,
        tree: git('ls-tree', '-r', '-t', '-l', ref)
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                const [meta, path] = line.split('\t');
                const [mode, type, sha, size] = meta.trim().split(/\s+/);
                return { path, mode, type, sha, ...(type === 'blob' ? { size: Number(size) } : {}) };
            }),
    });

    function route(method, url) {
        if (method !== 'GET') return undefined;
        const p = url.pathname.replace(/^\/api\/v3/, '');
        const q = (k) => url.searchParams.get(k) || undefined;
        const base = `/repos/${owner}/${repository.name}`;
        if (p === `/orgs/${owner}/repos`) return [repo()];
        if (p === base) return repo();
        if (p === `${base}/languages`) return { TypeScript: tree(refOf(pr.head)).tree.reduce((n, f) => n + (f.size || 0), 0) };
        if (p === `${base}/pulls`) return ['open', 'all', undefined].includes(q('state')) ? [pull()] : [];
        if (p === `${base}/pulls/${pr.number}`) return pull();
        if (p === `${base}/pulls/${pr.number}/files`) return files();
        if (p === `${base}/pulls/${pr.number}/commits`) return commits(pr.head).reverse().slice(1);
        if (p === `${base}/commits`) return commits(q('sha'));
        if (p.startsWith(`${base}/contents/`)) return content(refOf(q('ref')), decodeURIComponent(p.slice(`${base}/contents/`.length)));
        if (p.startsWith(`${base}/git/trees/`)) return tree(refOf(decodeURIComponent(p.slice(`${base}/git/trees/`.length))));
        return undefined;
    }

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            origin = `http://127.0.0.1:${server.address().port}`;
            resolve({ host: origin, misses, close: () => new Promise((r) => server.close(() => r())) });
        });
    });
}

module.exports = { startGithubRest };
