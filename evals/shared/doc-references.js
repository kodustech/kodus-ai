// Checks that what the eval docs point at still exists: file paths in backticks,
// relative markdown links, `pnpm eval:*` scripts and `node <file>` commands.
//
// The docs deliberately don't copy numbers or lists (floors, tier-0 models,
// schedules) — they point at the file that owns the fact. That only works if the
// pointers stay true, and a stale pointer is exactly how the eval harness drifted
// last time. engine-gate's preflight runs this, so it fails on the PR.
const fs = require('fs');
const path = require('path');

const REPO_PATH = /^(evals|libs|apps|scripts|tests|test|docs|\.github)\//;

// A backticked token that names a repo file: rooted at a top-level dir, no
// spaces, no globs or placeholders, optional `:line` suffix.
function repoPathOf(token) {
    const candidate = token.trim().replace(/:\d+(-\d+)?$/, '').replace(/#.*$/, '');
    if (!REPO_PATH.test(candidate)) return null;
    if (/[\s*<>{}$|]/.test(candidate) || candidate.includes('...')) return null;
    return candidate.replace(/\/$/, '');
}

function findBrokenReferences(markdown, { docPath, root, scripts }) {
    const broken = [];
    const exists = (p) => fs.existsSync(path.join(root, p));
    // Fenced blocks hold examples (placeholders, other repos' paths); only the
    // commands in them are checked, below.
    const prose = markdown.replace(/```[\s\S]*?```/g, '');

    for (const [, token] of prose.matchAll(/`([^`\n]+)`/g)) {
        const repoPath = repoPathOf(token);
        if (repoPath && !exists(repoPath)) broken.push({ kind: 'path', ref: token });
    }

    for (const [, target] of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const resolved = path.normalize(path.join(path.dirname(docPath), target.replace(/#.*$/, '')));
        if (!exists(resolved)) broken.push({ kind: 'link', ref: target });
    }

    for (const [, name] of markdown.matchAll(/\bpnpm (?:run )?(eval:[\w:.-]+)/g)) {
        if (!scripts[name]) broken.push({ kind: 'script', ref: `pnpm ${name}` });
    }

    for (const [, file] of markdown.matchAll(/\bnode ((?:evals|scripts)\/[\w./-]+\.(?:js|ts))/g)) {
        if (!exists(file)) broken.push({ kind: 'command', ref: `node ${file}` });
    }

    const seen = new Set();
    return broken.filter(({ kind, ref }) => !seen.has(`${kind}:${ref}`) && seen.add(`${kind}:${ref}`));
}

const HEADER_FIELDS = ['Answers', 'Runs', 'Run it', 'Gate', 'Cost'];

// Every eval README opens with the same five fields, so a person or an agent
// can tell what it answers and whether it runs in CI without reading the rest.
function missingHeaderFields(markdown) {
    const top = markdown.split('\n').slice(0, 15).join('\n');
    return HEADER_FIELDS.filter((field) => !top.includes(`**${field}:**`));
}

// The docs the preflight holds to this: the evals entry points and every
// eval's own README.
function evalDocs(root) {
    const evalsDir = path.join(root, 'evals');
    const readmes = fs
        .readdirSync(evalsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join('evals', entry.name, 'README.md'))
        .filter((doc) => fs.existsSync(path.join(root, doc)));
    return { entryPoints: ['evals/README.md', 'evals/AGENTS.md'], readmes };
}

module.exports = { findBrokenReferences, missingHeaderFields, evalDocs, repoPathOf, HEADER_FIELDS };
