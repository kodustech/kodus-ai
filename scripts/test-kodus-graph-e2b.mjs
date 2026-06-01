/**
 * Standalone test: kodus-graph inside E2B sandbox
 *
 * Usage:
 *   E2B_API_KEY=... node scripts/test-kodus-graph-e2b.mjs [repo-url] [branch] [file1 file2 ...]
 *
 * Example:
 *   E2B_API_KEY=... node scripts/test-kodus-graph-e2b.mjs \
 *     https://github.com/Wellington01/sentry-greptile.git \
 *     optimize-spans-buffer \
 *     src/sentry/spans/buffer.py src/sentry/spans/consumers.py
 */

import { Sandbox } from 'e2b';

const REPO_DIR = '/home/user/repo';
const GRAPH_DIR = '.kodus-graph';
const GRAPH_PATH = `${GRAPH_DIR}/graph.json`;
const PROMPT_PATH = `${GRAPH_DIR}/prompt.txt`;
const KODUS_GRAPH_VERSION = '0.2.1';

const apiKey = process.env.E2B_API_KEY;
if (!apiKey) {
    console.error('E2B_API_KEY is required');
    process.exit(1);
}

const repoUrl = process.argv[2] || 'https://github.com/Wellington01/sentry-greptile.git';
const branch = process.argv[3] || 'master';

// Parse remaining args: files go to changedFiles, --exclude flags go to excludePatterns
const changedFiles = [];
const excludePatterns = [];
const includePatterns = [];
for (let i = 4; i < process.argv.length; i++) {
    if (process.argv[i] === '--exclude' && process.argv[i + 1]) {
        excludePatterns.push(process.argv[++i]);
    } else if (process.argv[i] === '--include' && process.argv[i + 1]) {
        includePatterns.push(process.argv[++i]);
    } else {
        changedFiles.push(process.argv[i]);
    }
}

async function run(sandbox, cmd, label, timeoutMs = 120_000) {
    console.log(`\n--- ${label} ---`);
    console.log(`$ ${cmd}`);
    const t0 = Date.now();
    try {
        const result = await sandbox.commands.run(cmd, { timeoutMs });
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`  exit=${result.exitCode}  (${elapsed}s)`);
        if (result.stdout) console.log(`  stdout: ${result.stdout.slice(0, 2000)}`);
        if (result.stderr) console.log(`  stderr: ${result.stderr.slice(0, 1000)}`);
        return result;
    } catch (err) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const r = err.result || {};
        console.log(`  exit=${r.exitCode ?? 'error'}  (${elapsed}s)`);
        if (r.stdout) console.log(`  stdout: ${r.stdout.slice(0, 2000)}`);
        if (r.stderr) console.log(`  stderr: ${r.stderr.slice(0, 1000)}`);
        return { exitCode: r.exitCode ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
    }
}

async function main() {
    console.log('=== kodus-graph E2B Test ===');
    console.log(`Repo: ${repoUrl}`);
    console.log(`Branch: ${branch}`);
    console.log(`Changed files: ${changedFiles.length ? changedFiles.join(', ') : '(auto-detect from git diff)'}`);

    const templateId = process.env.API_E2B_TEMPLATE_ID;
    console.log(`\nCreating sandbox${templateId ? ` (template=${templateId})` : ''}...`);

    const sandbox = templateId
        ? await Sandbox.create(templateId, { timeoutMs: 600_000, apiKey })
        : await Sandbox.create({ timeoutMs: 600_000, apiKey });

    console.log(`Sandbox created: ${sandbox.sandboxId}`);

    try {
        // Step 1: Clone repo
        await run(sandbox,
            `git clone --depth 50 --branch ${branch} ${repoUrl} ${REPO_DIR} 2>&1`,
            'Clone repo', 300_000);

        // Step 2: List files to confirm
        await run(sandbox, `ls -la ${REPO_DIR} | head -20`, 'List repo root');

        // Step 3: Install bun + kodus-graph
        await run(sandbox, [
            'which bun > /dev/null 2>&1 || (curl -fsSL https://bun.sh/install | bash > /dev/null 2>&1)',
            'export PATH="$HOME/.bun/bin:$PATH"',
            'bun --version',
        ].join(' && '), 'Install bun', 120_000);

        await run(sandbox, [
            'export PATH="$HOME/.bun/bin:$PATH"',
            `bun install -g @kodus/kodus-graph@${KODUS_GRAPH_VERSION} 2>&1`,
        ].join(' && '), `Install kodus-graph@${KODUS_GRAPH_VERSION}`, 120_000);

        // Step 4: Verify kodus-graph is available
        await run(sandbox, [
            'export PATH="$HOME/.bun/bin:$PATH"',
            'kodus-graph --version 2>&1 || echo "kodus-graph not found in PATH"',
        ].join(' && '), 'Verify kodus-graph');

        // Step 5: Parse full repo
        const parseResult = await run(sandbox, [
            'export PATH="$HOME/.bun/bin:$PATH"',
            `cd ${REPO_DIR}`,
            `mkdir -p ${GRAPH_DIR}`,
            `kodus-graph parse --all --repo-dir . --out ${GRAPH_PATH}${includePatterns.map(p => ` --include "${p}"`).join('')}${excludePatterns.map(p => ` --exclude "${p}"`).join('')} 2>&1`,
        ].join(' && '), 'Parse repo', 300_000);

        if (parseResult.exitCode !== 0) {
            console.error('\nParse FAILED - stopping here');
            return;
        }

        // Step 6: Check graph.json stats
        await run(sandbox, [
            `wc -c ${REPO_DIR}/${GRAPH_PATH}`,
            `cat ${REPO_DIR}/${GRAPH_PATH} | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const j=JSON.parse(d);console.log('nodes:',j.nodes?.length,'edges:',j.edges?.length)" 2>/dev/null || echo "(could not parse graph.json)"`,
        ].join(' && '), 'Graph stats');

        // Step 7: Detect changed files if not provided
        let files = changedFiles;
        if (files.length === 0) {
            const diffResult = await run(sandbox, [
                `cd ${REPO_DIR}`,
                `git diff --name-only HEAD~1 2>/dev/null || git diff --name-only HEAD 2>/dev/null || echo "no diff available"`,
            ].join(' && '), 'Detect changed files');
            files = (diffResult.stdout || '').trim().split('\n').filter(Boolean);
            if (files.length === 0 || files[0] === 'no diff available') {
                // Fallback: pick a few source files
                const lsResult = await run(sandbox, `find ${REPO_DIR}/src -name "*.py" -o -name "*.ts" -o -name "*.go" -o -name "*.java" 2>/dev/null | head -5`, 'Find sample files');
                files = (lsResult.stdout || '').trim().split('\n').filter(Boolean).map(f => f.replace(`${REPO_DIR}/`, ''));
            }
        }

        console.log(`\nFiles for context: ${files.join(', ')}`);

        // Step 8: Generate context (JSON)
        await run(sandbox, [
            'export PATH="$HOME/.bun/bin:$PATH"',
            `cd ${REPO_DIR}`,
            `kodus-graph context --files ${files.join(' ')} --graph ${GRAPH_PATH} --repo-dir . --format json 2>&1 | head -100`,
        ].join(' && '), 'Context (JSON)', 60_000);

        // Step 9: Generate context (prompt format)
        const promptResult = await run(sandbox, [
            'export PATH="$HOME/.bun/bin:$PATH"',
            `cd ${REPO_DIR}`,
            `kodus-graph context --files ${files.join(' ')} --graph ${GRAPH_PATH} --repo-dir . --format prompt --out ${PROMPT_PATH} 2>&1`,
        ].join(' && '), 'Context (prompt)', 60_000);

        if (promptResult.exitCode === 0) {
            const readResult = await run(sandbox,
                `cat ${REPO_DIR}/${PROMPT_PATH}`,
                'Prompt output');
            console.log('\n=== PROMPT OUTPUT (full) ===');
            console.log(readResult.stdout || '(empty)');
        }

    } finally {
        console.log('\nKilling sandbox...');
        await sandbox.kill();
        console.log('Done.');
    }
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
