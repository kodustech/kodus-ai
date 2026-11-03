// The benchmark PRs' repositories (evals/dedup/gold-v3/repos.json):
// caseId -> { repo, base, head }, with `repo` the clone's folder name resolved
// under the benchmark clones root, as evals/investigation/prepare-repo.js does.
const fs = require('fs');
const path = require('path');

const BENCH_ROOT = process.env.BENCH_REPOS_ROOT || path.join(process.env.HOME || '', 'projects/benchmark');
const FILE = path.join(__dirname, '../dedup/gold-v3/repos.json');

function loadBenchRepos() {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Object.fromEntries(
        Object.entries(raw).map(([caseId, r]) => [caseId, { ...r, repo: path.join(BENCH_ROOT, r.repo) }]),
    );
}

module.exports = { loadBenchRepos, BENCH_ROOT };
