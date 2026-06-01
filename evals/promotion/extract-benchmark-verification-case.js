#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '../..');
const INVESTIGATION_DATASETS_DIR = path.join(
    ROOT_DIR,
    'evals/investigation/datasets',
);
const OUTPUT_DIR = path.join(__dirname, 'datasets');
const BENCHMARK_CATALOG_PATH = path.join(
    ROOT_DIR,
    'scripts/benchmark/prs-benchmark.json',
);

function parseArgs(argv) {
    const args = argv.slice(2);
    const options = {
        run: null,
        title: null,
        output: null,
        overwrite: false,
    };

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];

        if (arg === '--run') {
            options.run = args[index + 1] || null;
            index += 1;
            continue;
        }

        if (arg === '--title') {
            options.title = args[index + 1] || null;
            index += 1;
            continue;
        }

        if (arg === '--output') {
            options.output = args[index + 1] || null;
            index += 1;
            continue;
        }

        if (arg === '--overwrite') {
            options.overwrite = true;
            continue;
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    if (!options.run) {
        throw new Error('Missing required flag: --run <benchmark-run-name>');
    }

    if (!options.title) {
        throw new Error('Missing required flag: --title "<benchmark PR title>"');
    }

    return options;
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getFirstArray(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
        for (const candidate of Object.values(value)) {
            if (Array.isArray(candidate)) return candidate;
        }
    }
    return [];
}

function slugify(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120);
}

function normalizePath(value) {
    return String(value || '')
        .replace(/^\/+/, '')
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .replace(/\/$/, '');
}

function parseLocation(location) {
    const match = String(location || '').match(/^(.*?):(\d+)(?:-(\d+))?$/);
    if (!match) {
        return {
            relevantFile: '',
            relevantLinesStart: null,
            relevantLinesEnd: null,
        };
    }

    const relevantLinesStart = Number(match[2]);
    const relevantLinesEnd = match[3] ? Number(match[3]) : relevantLinesStart;

    return {
        relevantFile: normalizePath(match[1]),
        relevantLinesStart,
        relevantLinesEnd,
    };
}

function extractOneSentenceSummary(comment) {
    const text = String(comment || '').trim();
    const whatMatch = text.match(/WHAT:\s*([^\n]+)/i);
    if (whatMatch?.[1]) {
        return whatMatch[1].trim();
    }

    const sentenceMatch = text.match(/^(.{1,180}?[.!?])(?:\s|$)/);
    if (sentenceMatch?.[1]) {
        return sentenceMatch[1].trim();
    }

    return text.slice(0, 180);
}

function loadBenchmarkCatalog() {
    return getFirstArray(readJson(BENCHMARK_CATALOG_PATH));
}

function loadInvestigationCase(title) {
    const entries = fs
        .readdirSync(INVESTIGATION_DATASETS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'));

    for (const entry of entries) {
        const datasetPath = path.join(INVESTIGATION_DATASETS_DIR, entry.name);
        const tests = readJson(datasetPath);
        if (!Array.isArray(tests)) continue;

        for (const test of tests) {
            const vars = test?.vars || {};
            if (String(vars.prTitle || '').trim() === title.trim()) {
                return {
                    datasetPath,
                    vars,
                };
            }
        }
    }

    return null;
}

function findBenchmarkCase(runName, title) {
    const candidatesPath = path.join(
        ROOT_DIR,
        'scripts/benchmark/results',
        runName,
        'candidates-severity.json',
    );
    const matchMatrixPath = path.join(
        ROOT_DIR,
        'scripts/benchmark/results',
        runName,
        'match-matrix.json',
    );

    const candidates = readJson(candidatesPath);
    const matchMatrix = readJson(matchMatrixPath);

    const prIndex = candidates.findIndex(
        (entry) => String(entry.pr_title || '').trim() === title.trim(),
    );

    if (prIndex === -1) {
        throw new Error(
            `Could not find PR title "${title}" in ${path.relative(ROOT_DIR, candidatesPath)}`,
        );
    }

    return {
        candidateEntry: candidates[prIndex],
        matchRows: Array.isArray(matchMatrix[prIndex]) ? matchMatrix[prIndex] : [],
    };
}

function extractPatchWindow(patchWithLinesStr, startLine, endLine, padding = 20) {
    const lines = String(patchWithLinesStr || '').split('\n');
    if (!startLine || !endLine || lines.length === 0) {
        return String(patchWithLinesStr || '');
    }

    const targetIndexes = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        // patchWithLinesStr formats lines as `   123 +foo` (number left-padded
        // with spaces, then a space, then the original diff line). The old
        // `:` delimiter never matched, so targetIndexes stayed empty and the
        // function silently returned the entire patch.
        const match = line.match(/^\s*(\d+)\s/);
        if (!match) continue;
        const lineNumber = Number(match[1]);
        if (lineNumber >= startLine - padding && lineNumber <= endLine + padding) {
            targetIndexes.push(index);
        }
    }

    if (targetIndexes.length === 0) {
        return String(patchWithLinesStr || '');
    }

    const sliceStart = Math.max(0, targetIndexes[0] - 2);
    const sliceEnd = Math.min(lines.length, targetIndexes[targetIndexes.length - 1] + 3);
    return lines.slice(sliceStart, sliceEnd).join('\n');
}

function extractFileWindow(fileContent, startLine, endLine, padding = 20) {
    const lines = String(fileContent || '').split('\n');
    if (!startLine || !endLine || lines.length === 0) {
        return String(fileContent || '');
    }

    const sliceStart = Math.max(0, startLine - 1 - padding);
    const sliceEnd = Math.min(lines.length, endLine + padding);
    return lines
        .slice(sliceStart, sliceEnd)
        .map((line, index) => `${sliceStart + index + 1}: ${line}`)
        .join('\n');
}

function buildDiffSnippet(changedFiles, relevantFile, startLine, endLine) {
    const changedFile = changedFiles.find(
        (entry) => normalizePath(entry.filename) === normalizePath(relevantFile),
    );
    if (!changedFile) return '';
    return extractPatchWindow(
        changedFile.patchWithLinesStr || changedFile.patch || '',
        startLine,
        endLine,
    );
}

function buildFileSnippet(readFileReplay, relevantFile, startLine, endLine) {
    const replayEntry = readFileReplay.find(
        (entry) =>
            normalizePath(entry?.match?.path) === normalizePath(relevantFile),
    );
    if (!replayEntry) return '';

    return extractFileWindow(
        replayEntry.result || '',
        startLine,
        endLine,
    );
}

function buildCallGraphHint(rawCallGraph, relevantFile, summary) {
    const callGraph = String(rawCallGraph || '');
    if (!callGraph.trim()) return '';

    const lowerFile = normalizePath(relevantFile).toLowerCase();
    const basename = lowerFile.split('/').pop() || '';
    const summaryTokens = String(summary || '')
        .toLowerCase()
        .match(/[a-z_][a-z0-9_]{3,}/g);

    const sections = callGraph
        .split(/\n{2,}/)
        .map((section) => section.trim())
        .filter(Boolean);

    const scored = sections
        .map((section) => {
            const lower = section.toLowerCase();
            let score = 0;
            if (lower.includes(lowerFile)) score += 3;
            if (basename && lower.includes(basename)) score += 2;
            for (const token of summaryTokens || []) {
                if (lower.includes(token)) score += 1;
            }

            return { section, score };
        })
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score);

    return scored.slice(0, 3).map((entry) => entry.section).join('\n\n');
}

function createPromptfooTests(options) {
    const benchmarkCatalog = loadBenchmarkCatalog();
    const benchmarkEntry = benchmarkCatalog.find(
        (entry) => String(entry.title || '').trim() === options.title.trim(),
    );
    if (!benchmarkEntry) {
        throw new Error(
            `Could not find benchmark catalog entry for title "${options.title}"`,
        );
    }

    const investigationCase = loadInvestigationCase(options.title);
    if (!investigationCase) {
        throw new Error(
            `Could not find investigation dataset with prTitle "${options.title}"`,
        );
    }

    const { candidateEntry, matchRows } = findBenchmarkCase(
        options.run,
        options.title,
    );

    const changedFiles = JSON.parse(investigationCase.vars.changedFiles || '[]');
    const toolReplay = JSON.parse(investigationCase.vars.toolReplay || '{}');
    const readFileReplay = Array.isArray(toolReplay.readFile)
        ? toolReplay.readFile
        : [];
    const relatedFiles = JSON.parse(
        investigationCase.vars.extractedFilePaths || '[]',
    );

    return (candidateEntry.issues || []).map((issue, candidateIndex) => {
        const location = parseLocation(issue.location);
        const matchedGoldens = matchRows
            .filter((row) => row.ci === candidateIndex && row.match)
            .map((row) => ({
                gi: row.gi,
                comment: benchmarkEntry.golden_comments?.[row.gi]?.comment || '',
                severity:
                    benchmarkEntry.golden_comments?.[row.gi]?.severity || '',
                reasoning: row.reasoning || '',
            }));
        const expectedKeep = matchedGoldens.length > 0;
        const oneSentenceSummary = extractOneSentenceSummary(issue.comment);

        const candidateFinding = {
            ...issue,
            relevantFile: location.relevantFile,
            relevantLinesStart: location.relevantLinesStart,
            relevantLinesEnd: location.relevantLinesEnd,
            oneSentenceSummary,
        };

        const diffSnippet = buildDiffSnippet(
            changedFiles,
            candidateFinding.relevantFile,
            candidateFinding.relevantLinesStart,
            candidateFinding.relevantLinesEnd,
        );
        const fileSnippet = buildFileSnippet(
            readFileReplay,
            candidateFinding.relevantFile,
            candidateFinding.relevantLinesStart,
            candidateFinding.relevantLinesEnd,
        );
        const callGraphHint = buildCallGraphHint(
            investigationCase.vars.callGraph,
            candidateFinding.relevantFile,
            oneSentenceSummary,
        );

        return {
            description: `${expectedKeep ? 'keep' : 'drop'} candidate #${candidateIndex} for ${options.title}`,
            vars: {
                caseId: `${slugify(options.title)}-candidate-${candidateIndex}-${expectedKeep ? 'keep' : 'drop'}`,
                mode: 'verification',
                prTitle: options.title,
                prBody: investigationCase.vars.prBody || '',
                repositoryFullName:
                    investigationCase.vars.repositoryFullName ||
                    candidateEntry.repo,
                benchmarkSourceUrl: benchmarkEntry.source_url,
                candidateIndex,
                candidateFinding: JSON.stringify(candidateFinding),
                relatedFiles: JSON.stringify(relatedFiles),
                diffSnippet,
                fileSnippet,
                investigationSummary: `Planner seed extracted files: ${relatedFiles.join(', ') || 'N/A'}`,
                callGraphHint,
                expectedKeep,
                expectedConfidenceAnyOf: JSON.stringify([
                    'high',
                    'medium',
                    'low',
                ]),
                matchedGoldenComments: JSON.stringify(matchedGoldens),
            },
            assert: [
                {
                    type: 'javascript',
                    value: 'file://promotion-assertion.js',
                },
            ],
        };
    });
}

function main() {
    const options = parseArgs(process.argv);
    const tests = createPromptfooTests(options);
    const benchmarkCase = findBenchmarkCase(options.run, options.title).candidateEntry;
    const defaultOutputPath = path.join(
        OUTPUT_DIR,
        `${slugify(options.title)}-${slugify(benchmarkCase.repo)}.json`,
    );
    const outputPath = options.output
        ? path.resolve(ROOT_DIR, options.output)
        : defaultOutputPath;

    if (fs.existsSync(outputPath) && !options.overwrite) {
        throw new Error(
            `Refusing to overwrite existing file: ${path.relative(ROOT_DIR, outputPath)}. Use --overwrite.`,
        );
    }

    fs.writeFileSync(outputPath, JSON.stringify(tests, null, 2));
    console.log(`Extracted ${options.title}`);
    console.log(`  -> ${outputPath}`);
}

main();
