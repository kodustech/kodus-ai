#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
    DEFAULT_OUT_DIR,
    extractBenchmarkCase,
    slugify,
} = require('./extract-benchmark-case.js');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_INPUT = path.join(
    __dirname,
    'results',
    'benchmark-case-candidates.json',
);

function parseArgs(argv) {
    const options = {
        input: DEFAULT_INPUT,
        outDir: DEFAULT_OUT_DIR,
        top: null,
        overwrite: false,
        dryRun: false,
        maxFiles: 6,
        categories: ['bug'],
        includeTests: false,
    };

    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];

        if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        }

        if (arg === '--overwrite') {
            options.overwrite = true;
            continue;
        }

        if (arg === '--dry-run') {
            options.dryRun = true;
            continue;
        }

        if (arg === '--include-tests') {
            options.includeTests = true;
            continue;
        }

        const next = argv[i + 1];
        if (!arg.startsWith('--') || next == null) continue;

        switch (arg) {
            case '--input':
                options.input = path.resolve(ROOT, next);
                i += 1;
                break;
            case '--out-dir':
                options.outDir = path.resolve(ROOT, next);
                i += 1;
                break;
            case '--top': {
                const parsed = Number(next);
                if (Number.isFinite(parsed) && parsed > 0) {
                    options.top = Math.trunc(parsed);
                }
                i += 1;
                break;
            }
            case '--max-files': {
                const parsed = Number(next);
                if (Number.isFinite(parsed) && parsed > 0) {
                    options.maxFiles = Math.trunc(parsed);
                }
                i += 1;
                break;
            }
            case '--categories':
                options.categories = String(next)
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean);
                i += 1;
                break;
            default:
                break;
        }
    }

    return options;
}

function printHelp() {
    console.log(`Extract multiple benchmark candidates into investigation datasets.

Usage:
  node evals/investigation/extract-benchmark-candidates.js [options]

Options:
  --input <path>        Candidate shortlist JSON (default: evals/investigation/results/benchmark-case-candidates.json)
  --out-dir <path>      Output directory for extracted datasets (default: evals/investigation/datasets)
  --top <n>             Extract only the top N candidates from the shortlist
  --max-files <n>       Max changed files per extracted case (default: 6)
  --categories <list>   Requested categories, comma-separated (default: bug)
  --include-tests       Allow test files into the initial extraction set
  --overwrite           Replace existing dataset files instead of skipping them
  --dry-run             Print planned extraction targets without calling GitHub

Examples:
  node evals/investigation/extract-benchmark-candidates.js --top 5
  node evals/investigation/extract-benchmark-candidates.js --top 10 --overwrite
`);
}

function loadCandidates(inputPath) {
    if (!fs.existsSync(inputPath)) {
        throw new Error(`Candidate file not found: ${inputPath}`);
    }

    const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
    if (!candidates.length) {
        throw new Error(`No candidates found in ${inputPath}`);
    }

    return candidates;
}

function buildOutputPath(outDir, candidate) {
    const repoSlug = slugify(candidate.repo || 'repo');
    const titleSlug = slugify(candidate.title || candidate.sourceUrl || 'candidate');
    return path.join(outDir, `${titleSlug}-${repoSlug}.json`);
}

function main() {
    const options = parseArgs(process.argv);
    const candidates = loadCandidates(options.input).slice(
        0,
        options.top || undefined,
    );

    const planned = candidates.map((candidate) => ({
        title: candidate.title,
        sourceUrl: candidate.sourceUrl,
        outPath: buildOutputPath(options.outDir, candidate),
    }));

    if (options.dryRun) {
        console.log('Planned benchmark extractions:\n');
        for (const [index, entry] of planned.entries()) {
            console.log(`${index + 1}. ${entry.title}`);
            if (entry.sourceUrl) console.log(`   source: ${entry.sourceUrl}`);
            console.log(`   out: ${entry.outPath}`);
        }
        return;
    }

    const written = [];
    const skipped = [];
    const failed = [];

    for (const candidate of candidates) {
        const outPath = buildOutputPath(options.outDir, candidate);
        if (fs.existsSync(outPath) && !options.overwrite) {
            skipped.push({
                title: candidate.title,
                outPath,
                reason: 'exists',
            });
            continue;
        }

        try {
            const result = extractBenchmarkCase({
                title: candidate.title,
                out: outPath,
                maxFiles: options.maxFiles,
                categories: options.categories,
                includeTests: options.includeTests,
            });
            written.push({
                title: candidate.title,
                outPath: result.outPath,
            });
            console.log(`Extracted ${candidate.title}`);
            console.log(`  -> ${result.outPath}`);
        } catch (error) {
            failed.push({
                title: candidate.title,
                outPath,
                error: error.message,
            });
            console.error(`Failed ${candidate.title}`);
            console.error(`  -> ${error.message}`);
        }
    }

    console.log('\nBenchmark extraction summary');
    console.log(`written=${written.length} skipped=${skipped.length} failed=${failed.length}`);

    if (skipped.length) {
        console.log('\nSkipped:');
        for (const entry of skipped) {
            console.log(`- ${entry.title} (${entry.reason})`);
        }
    }

    if (failed.length) {
        console.log('\nFailed:');
        for (const entry of failed) {
            console.log(`- ${entry.title}: ${entry.error}`);
        }
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main();
}
