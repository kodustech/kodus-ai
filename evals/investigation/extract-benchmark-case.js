#!/usr/bin/env node

require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
    convertToHunksWithLinesNumbers,
} = require('../../libs/common/utils/patch.ts');

const ROOT = path.resolve(__dirname, '../..');
const BENCHMARK_PATH = path.join(ROOT, 'scripts/benchmark/prs-benchmark.json');
const DEFAULT_OUT_DIR = path.join(__dirname, 'datasets');

function parseArgs(argv) {
    const args = argv.slice(2);
    const options = {
        maxFiles: 6,
        categories: ['bug'],
        includeTests: false,
    };

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];

        if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        }

        if (!arg.startsWith('--')) continue;

        const key = arg.slice(2);
        const next = args[i + 1];

        if (key === 'max-files') {
            options.maxFiles = Number(next || options.maxFiles);
            i += 1;
            continue;
        }

        if (key === 'categories') {
            options.categories = String(next || '')
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean);
            i += 1;
            continue;
        }

        if (key === 'include-files') {
            options.includeFiles = String(next || '')
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean);
            i += 1;
            continue;
        }

        if (
            key === 'title' ||
            key === 'source-url' ||
            key === 'out' ||
            key === 'case-id'
        ) {
            options[toCamelCase(key)] = next;
            i += 1;
            continue;
        }

        if (key === 'include-tests') {
            options.includeTests = true;
            continue;
        }
    }

    if (!options.title && !options.sourceUrl) {
        console.error('Missing --title or --source-url');
        printHelp();
        process.exit(1);
    }

    if (!Number.isFinite(options.maxFiles) || options.maxFiles < 1) {
        console.error('--max-files must be a positive integer');
        process.exit(1);
    }

    return options;
}

function printHelp() {
    console.log(`Extract a real benchmark PR/commit into an investigation eval case.

Usage:
  node evals/investigation/extract-benchmark-case.js --title "AuthZService: improve authz caching"
  node evals/investigation/extract-benchmark-case.js --source-url "https://github.com/grafana/grafana/pull/103633"

Options:
  --title <text>         Exact benchmark PR title from scripts/benchmark/prs-benchmark.json
  --source-url <url>     Benchmark source_url instead of title
  --case-id <id>         Override generated case id
  --out <path>           Output JSON path (default: evals/investigation/datasets/<slug>.json)
  --max-files <n>        Max changed files to embed into the initial case (default: 6)
  --categories <list>    Requested categories, comma-separated (default: bug)
  --include-files <csv>  Force the extraction set to these changed files, in this order
  --include-tests        Allow test files into the initial extraction set
`);
}

function toCamelCase(value) {
    return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function readBenchmark() {
    return JSON.parse(fs.readFileSync(BENCHMARK_PATH, 'utf8')).prs || [];
}

function findBenchmarkPR(prs, options) {
    if (options.sourceUrl) {
        const exact = prs.find((pr) => pr.source_url === options.sourceUrl);
        if (exact) return exact;
    }

    if (options.title) {
        const exact = prs.find((pr) => pr.title === options.title);
        if (exact) return exact;

        const lowered = options.title.toLowerCase();
        const partial = prs.find((pr) => pr.title.toLowerCase().includes(lowered));
        if (partial) return partial;
    }

    return null;
}

function parseSourceUrl(sourceUrl) {
    const match = sourceUrl.match(
        /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(pull|commit)\/([^/?#]+)/,
    );

    if (!match) {
        throw new Error(`Unsupported GitHub source_url: ${sourceUrl}`);
    }

    const [, owner, repo, kind, value] = match;
    return { owner, repo, kind, value };
}

function gh(endpoint, { paginate = false } = {}) {
    const args = ['api', endpoint];
    if (paginate) args.push('--paginate');

    const output = execFileSync('gh', args, {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    return JSON.parse(output);
}

function slugify(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}

function decodeBase64(content) {
    return Buffer.from(String(content || '').replace(/\n/g, ''), 'base64').toString(
        'utf8',
    );
}

function fetchFileContent(owner, repo, ref, filePath) {
    const endpoint = `repos/${owner}/${repo}/contents/${filePath}?ref=${ref}`;
    const payload = gh(endpoint);
    if (!payload || payload.type !== 'file' || !payload.content) {
        throw new Error(`Unexpected contents payload for ${filePath}`);
    }
    return decodeBase64(payload.content);
}

function fetchPRCaseData(parsed) {
    const pr = gh(`repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.value}`);
    const files = gh(
        `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.value}/files`,
        { paginate: true },
    );

    return {
        title: pr.title,
        description: pr.body || '',
        repositoryFullName: `${parsed.owner}/${parsed.repo}`,
        ref: pr.head.sha,
        baseRef: pr.base.sha,
        changedFiles: files,
    };
}

function fetchCommitCaseData(parsed) {
    const commit = gh(`repos/${parsed.owner}/${parsed.repo}/commits/${parsed.value}`);

    return {
        title: commit.commit?.message?.split('\n')[0] || `Commit ${parsed.value}`,
        description: commit.commit?.message || '',
        repositoryFullName: `${parsed.owner}/${parsed.repo}`,
        ref: commit.sha,
        baseRef: null,
        changedFiles: commit.files || [],
    };
}

function buildListDirFixture(files) {
    const entries = new Set(['.']);

    for (const filePath of files) {
        const normalized = String(filePath || '').replace(/^\/+/, '');
        if (!normalized) continue;

        const parts = normalized.split('/');
        let current = '';
        for (let i = 0; i < parts.length - 1; i += 1) {
            current = current ? `${current}/${parts[i]}` : parts[i];
            entries.add(current);
        }
        entries.add(normalized);
    }

    return Array.from(entries)
        .sort((left, right) => left.localeCompare(right))
        .join('\n')
        .concat('\n');
}

function isProbablyTestFile(filePath) {
    return /(^|\/)(__tests__|tests?|spec)\//i.test(filePath) ||
        /\.(test|spec)\.[^.]+$/i.test(filePath);
}

function filePriority(file) {
    const filePath = String(file?.filename || '');
    const lower = filePath.toLowerCase();
    let score = 0;

    if (isProbablyTestFile(filePath)) score += 120;
    if (/(^|\/)(static|public|docs?|storybook|fixtures?)\//i.test(filePath)) {
        score += 90;
    }
    if (/(^|\/)(migrations?|devservices)\//i.test(filePath)) {
        score += 80;
    }
    if (/\.(json|ya?ml|toml|lock|md|snap)$/i.test(filePath)) {
        score += 70;
    }
    if (/\.(tsx?|jsx?)$/i.test(filePath)) {
        score += 30;
    }
    if (/\.(go|py|rb|java|kt|rs|cs|php)$/i.test(filePath)) {
        score -= 20;
    }
    if (/(^|\/)(src|pkg|app|internal|server|backend|services?)\//i.test(filePath)) {
        score -= 15;
    }
    if (/(^|\/)(workflow_engine|replays|authz|rbac|issues|grouping)\//i.test(lower)) {
        score -= 10;
    }

    const patchLength = String(file?.patch || '').length;
    if (patchLength > 0) {
        score -= Math.min(Math.floor(patchLength / 400), 10);
    }

    return score;
}

function buildCaseSkeleton(benchmarkPR, fetched, options) {
    const candidates = (fetched.changedFiles || []).filter(
        (file) => file.patch && file.filename,
    );
    const forced = Array.isArray(options.includeFiles) && options.includeFiles.length
        ? options.includeFiles
              .map((wantedPath) =>
                  candidates.find((file) => file.filename === wantedPath),
              )
              .filter(Boolean)
        : null;
    const prioritized = options.includeTests
        ? [...candidates].sort((left, right) => filePriority(left) - filePriority(right))
        : candidates
              .filter((file) => !isProbablyTestFile(file.filename))
              .sort((left, right) => filePriority(left) - filePriority(right));

    const changedFiles = (forced || prioritized).slice(0, options.maxFiles);

    const omittedFiles = forced
        ? prioritized
              .filter(
                  (file) =>
                      !changedFiles.some(
                          (selected) => selected.filename === file.filename,
                      ),
              )
              .map((file) => file.filename)
        : prioritized.slice(options.maxFiles).map((file) => file.filename);

    const changedFilesForPrompt = [];
    const readFileReplay = [];

    for (const file of changedFiles) {
        const patchWithLinesStr = convertToHunksWithLinesNumbers(file.patch, {
            filename: file.filename,
        });

        changedFilesForPrompt.push({
            filename: file.filename,
            patchWithLinesStr,
        });

        let fileContent = '';
        try {
            fileContent = fetchFileContent(
                ...fetched.repositoryFullName.split('/'),
                fetched.ref,
                file.filename,
            );
        } catch (error) {
            fileContent = `Unable to fetch file contents for ${file.filename}: ${error.message}`;
        }

        readFileReplay.push({
            match: {
                path: file.filename,
            },
            result: fileContent,
        });
    }

    const filePaths = changedFiles.map((file) => file.filename);
    const listDirResult = buildListDirFixture(filePaths);
    const caseId =
        options.caseId ||
        `${slugify(benchmarkPR.title)}-${slugify(benchmarkPR.repo.split('/').pop())}`;

    return {
        description: `real benchmark extraction for ${benchmarkPR.title}`,
        vars: {
            caseId,
            mode: 'planner',
            prTitle: fetched.title,
            prBody: fetched.description,
            repositoryFullName: fetched.repositoryFullName,
            reviewMode: 'normal',
            maxSteps: 12,
            requestedCategories: JSON.stringify(options.categories),
            changedFiles: JSON.stringify(changedFilesForPrompt),
            toolReplay: JSON.stringify({
                readFile: readFileReplay,
                listDir: [
                    {
                        match: {
                            path: '.',
                            maxDepth: 6,
                        },
                        result: listDirResult,
                    },
                ],
                grep: [],
            }),
            goldenComments: JSON.stringify(benchmarkPR.golden_comments || []),
            benchmarkSourceUrl: benchmarkPR.source_url,
            benchmarkBaseRef: fetched.baseRef,
            benchmarkHeadRef: fetched.ref,
            extractedFilePaths: JSON.stringify(filePaths),
            omittedFilePaths: JSON.stringify(omittedFiles),
            expectedRequiredTools: JSON.stringify(['readFile']),
            expectedForbiddenTools: JSON.stringify(['searchDocs', 'checkTypes']),
            expectedMaxSteps: 12,
            expectedMaxRepeatedReadPerFile: 3,
        },
        assert: [
            {
                type: 'javascript',
                value: 'file://investigation-assertion.js',
            },
        ],
    };
}

function extractBenchmarkCase(options) {
    const benchmarkPR = findBenchmarkPR(readBenchmark(), options);

    if (!benchmarkPR) {
        throw new Error(
            `Benchmark PR not found for ${options.title || options.sourceUrl}`,
        );
    }

    const parsed = parseSourceUrl(benchmarkPR.source_url);
    const fetched =
        parsed.kind === 'pull'
            ? fetchPRCaseData(parsed)
            : fetchCommitCaseData(parsed);

    const caseData = buildCaseSkeleton(benchmarkPR, fetched, options);

    const outPath =
        options.out ||
        path.join(
            DEFAULT_OUT_DIR,
            `${slugify(caseData.vars.caseId || benchmarkPR.title)}.json`,
        );

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify([caseData], null, 2)}\n`);

    return {
        outPath,
        benchmarkPR,
        fetched,
        caseData,
    };
}

function main() {
    const options = parseArgs(process.argv);
    const { outPath, benchmarkPR, caseData } = extractBenchmarkCase(options);

    console.log(`Wrote ${outPath}`);
    console.log(
        JSON.stringify(
            {
                title: benchmarkPR.title,
                sourceUrl: benchmarkPR.source_url,
                includedFiles: JSON.parse(caseData.vars.extractedFilePaths),
                omittedFiles: JSON.parse(caseData.vars.omittedFilePaths),
            },
            null,
            2,
        ),
    );
}

if (require.main === module) {
    main();
}

module.exports = {
    DEFAULT_OUT_DIR,
    buildCaseSkeleton,
    extractBenchmarkCase,
    fetchCommitCaseData,
    fetchPRCaseData,
    findBenchmarkPR,
    parseSourceUrl,
    readBenchmark,
    slugify,
};
