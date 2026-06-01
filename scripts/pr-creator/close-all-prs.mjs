import { execSync } from 'child_process';

const DEFAULT_OWNER = process.env.BENCHMARK_OWNER || 'ai-code-review-benchmark';
const DEFAULT_REPOS = [
    'sentry',
    'grafana-codex',
    'discourse-cursor',
    'cal.com',
    'keycloak',
];

function resolveRepos() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        return DEFAULT_REPOS.map((repo) => `${DEFAULT_OWNER}/${repo}`);
    }

    const [first, ...rest] = args;

    if (first.includes('/')) {
        return args;
    }

    const owner = first;
    const repos = rest.length > 0 ? rest : DEFAULT_REPOS;
    return repos.map((repo) => `${owner}/${repo}`);
}

async function main() {
    const repos = resolveRepos();

    console.log('Cleaning open benchmark PRs...\n');

    for (const repo of repos) {
        console.log(`Checking ${repo}...`);
        try {
            const output = execSync(
                `gh pr list -R ${repo} --state open --json number -q '.[].number'`,
                { encoding: 'utf-8' },
            ).trim();

            if (!output) {
                console.log('  No open PRs found.');
                continue;
            }

            const prNumbers = output.split('\n').filter(Boolean);
            console.log(`  Closing ${prNumbers.length} open PR(s)...`);

            for (const number of prNumbers) {
                try {
                    execSync(
                        `gh pr close ${number} -R ${repo} --delete-branch=false`,
                        { stdio: 'pipe' },
                    );
                    console.log(`    Closed PR #${number}`);
                } catch {
                    console.error(`    Failed to close PR #${number}`);
                }
            }
        } catch (error) {
            console.error(`  Failed to list PRs in ${repo}: ${error.message}`);
        }
    }

    console.log('\nDone.');
}

main();
