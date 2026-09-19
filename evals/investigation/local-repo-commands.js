// RemoteCommands backed by a REAL git working tree instead of the recorded
// fixtures (ReplayRemoteCommands in agent-provider.js).
//
// Why this exists: the replay only answers tool calls that were captured when
// the dataset was built. Any NEW search returns empty — which is fine while the
// agent only re-reads the diff, but blocks the whole selector idea (Plan/Shard
// from the agentic map-reduce writeup): a selector's entire job is to search
// for code the diff does NOT contain, so by construction it queries things the
// fixtures never recorded. It also closes a standing measurement gap: ~15% of
// tool calls in recent runs went unserved, so every run was scored on a partly
// blind agent.
//
// Same three-method surface as the sandbox (RemoteCommands in
// collectCrossFileContexts.service.ts), so it drops into the same seam.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const MAX_OUTPUT = 60_000;
const EXEC_TIMEOUT_MS = 20_000;

/** ripgrep when available (fast, respects .gitignore), grep -r otherwise. */
let rgChecked = false;
let hasRg = false;
async function ripgrepAvailable() {
    if (rgChecked) return hasRg;
    rgChecked = true;
    try {
        await execFileAsync('rg', ['--version'], { timeout: 5000 });
        hasRg = true;
    } catch {
        hasRg = false;
    }
    return hasRg;
}

class LocalRepoCommands {
    /** @param {string} repoRoot absolute path to the prepared working tree */
    constructor(repoRoot) {
        this.repoRoot = repoRoot;
        // Same telemetry shape the replay exposes, so serializeResult and the
        // fidelity metric keep working unchanged. `unexpectedCalls` stays empty
        // by construction here: a real search that finds nothing is a valid
        // answer, not an unserved call.
        this.calls = [];
        this.unexpectedCalls = [];
    }

    _record(kind, actual) {
        this.calls.push({ kind, actual, matched: true });
    }

    /** Keep every path inside the repo — a traversal would read the host FS. */
    _resolve(p) {
        const rel = String(p || '.').replace(/^\/+/, '');
        const abs = path.resolve(this.repoRoot, rel);
        if (!abs.startsWith(path.resolve(this.repoRoot))) {
            return null;
        }
        return abs;
    }

    async grep(pattern, searchPath, glob) {
        this._record('grep', { pattern, path: searchPath, glob });
        const abs = this._resolve(searchPath || '.');
        if (!abs || !fs.existsSync(abs)) return '';
        try {
            if (await ripgrepAvailable()) {
                const args = ['--line-number', '--no-heading', '--color=never', '--max-count=50'];
                if (glob) args.push('--glob', glob);
                args.push('--', pattern, abs);
                const { stdout } = await execFileAsync('rg', args, {
                    timeout: EXEC_TIMEOUT_MS,
                    maxBuffer: MAX_OUTPUT * 4,
                    cwd: this.repoRoot,
                });
                return this._trim(stdout);
            }
            const args = ['-rn', '--binary-files=without-match'];
            if (glob) args.push(`--include=${glob}`);
            args.push('--', pattern, abs);
            const { stdout } = await execFileAsync('grep', args, {
                timeout: EXEC_TIMEOUT_MS,
                maxBuffer: MAX_OUTPUT * 4,
                cwd: this.repoRoot,
            });
            return this._trim(stdout);
        } catch (err) {
            // rg/grep exit 1 = "no matches", which is a legitimate answer.
            if (err && err.code === 1) return '';
            return '';
        }
    }

    async read(filePath, start, end) {
        this._record('readFile', { path: filePath, start, end });
        const abs = this._resolve(filePath);
        if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return '';
        let content;
        try {
            content = fs.readFileSync(abs, 'utf8');
        } catch {
            return '';
        }
        const lines = content.split('\n');
        const from = Number.isFinite(start) && start > 0 ? start - 1 : 0;
        const to = Number.isFinite(end) && end > 0 ? end : lines.length;
        // Number the lines the way the sandbox does — findings anchor to these.
        return this._trim(
            lines
                .slice(from, to)
                .map((l, i) => `${from + i + 1}: ${l}`)
                .join('\n'),
        );
    }

    async listDir(dirPath, maxDepth) {
        this._record('listDir', { path: dirPath, maxDepth });
        const abs = this._resolve(dirPath || '.');
        if (!abs || !fs.existsSync(abs)) return '';
        const depth = Number.isFinite(maxDepth) && maxDepth > 0 ? maxDepth : 2;
        const out = [];
        const walk = (dir, level, prefix) => {
            if (level > depth || out.length > 2000) return;
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const e of entries) {
                if (e.name === '.git' || e.name === 'node_modules') continue;
                const rel = prefix ? `${prefix}/${e.name}` : e.name;
                out.push(e.isDirectory() ? `${rel}/` : rel);
                if (e.isDirectory()) walk(path.join(dir, e.name), level + 1, rel);
            }
        };
        walk(abs, 1, '');
        return this._trim(out.join('\n'));
    }

    _trim(s) {
        const str = String(s || '');
        return str.length > MAX_OUTPUT
            ? `${str.slice(0, MAX_OUTPUT)}\n... [truncated]`
            : str;
    }
}

module.exports = { LocalRepoCommands };
