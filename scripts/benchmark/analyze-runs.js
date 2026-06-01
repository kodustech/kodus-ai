#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const {
    loadJson,
    loadManifest,
    resolveResultsDir,
    writeJson,
} = require('./benchmark-lib');

const LEVELS = ['all', 'critical', 'high', 'medium'];

function parseArgs(argv) {
    const runRefs = [];
    let outputDir = null;

    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--output-dir') {
            outputDir = argv[i + 1] ? path.resolve(argv[i + 1]) : null;
            i += 1;
            continue;
        }
        runRefs.push(arg);
    }

    return { runRefs, outputDir };
}

function mean(values) {
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sd(values) {
    if (!values.length) return 0;
    const avg = mean(values);
    const variance =
        values.reduce((sum, value) => sum + (value - avg) ** 2, 0) /
        values.length;
    return Math.sqrt(variance);
}

function metricSummary(values) {
    if (!values.length) {
        return { mean: 0, sd: 0, min: 0, max: 0, range: 0 };
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    return {
        mean: mean(values),
        sd: sd(values),
        min,
        max,
        range: max - min,
    };
}

function round(value, digits = 4) {
    return Number(value.toFixed(digits));
}

function loadRunArtifacts(runRef) {
    const { runName, manifestPath, manifest } = loadManifest(runRef);
    const resultsDir = resolveResultsDir(runName);
    const prMetadataPath = path.join(resultsDir, 'pr-metadata.json');
    const prMetadata = fs.existsSync(prMetadataPath)
        ? loadJson(prMetadataPath)
        : null;

    const levels = {};
    for (const level of LEVELS) {
        const filePath = path.join(resultsDir, `results-${level}.json`);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Missing results file: ${filePath}`);
        }
        levels[level] = loadJson(filePath);
    }

    return {
        manifest,
        manifestPath,
        prMetadata,
        resultsDir,
        runName,
        levels,
    };
}

function getProcessedEntries(runArtifacts, levelName) {
    const level = runArtifacts.levels[levelName];
    if (runArtifacts.prMetadata?.prs) {
        return runArtifacts.prMetadata.prs.filter((entry) => entry.processed);
    }

    const fallback = runArtifacts.manifest.prs.filter((entry) => entry.prNumber);
    return fallback.slice(0, level.prResults.length);
}

function buildPerPrSeries(runArtifactsByName, levelName) {
    const series = new Map();

    for (const runArtifacts of runArtifactsByName) {
        const level = runArtifacts.levels[levelName];
        const processedEntries = getProcessedEntries(runArtifacts, levelName);

        level.prResults.forEach((prResult, index) => {
            const meta = processedEntries[index] || {};
            const repo = meta.repo || prResult.repo;
            const head = meta.head || `index-${index}`;
            const title = meta.title || prResult.title;
            const key = `${repo}#${head}`;
            const candidateCount = prResult.candidates || 0;
            const goldenCount = prResult.golden || 0;
            const precision =
                candidateCount > 0 ? prResult.tp / candidateCount : 0;
            const recall = goldenCount > 0 ? prResult.tp / goldenCount : 0;
            const f1 =
                precision + recall === 0
                    ? 0
                    : (2 * precision * recall) / (precision + recall);

            if (!series.has(key)) {
                series.set(key, {
                    repo,
                    head,
                    prNumber: meta.prNumber || null,
                    title,
                    runs: [],
                });
            }

            series.get(key).runs.push({
                run: runArtifacts.runName,
                tp: prResult.tp,
                fp: prResult.fp,
                fn: prResult.fn,
                golden: goldenCount,
                candidates: candidateCount,
                precision,
                recall,
                f1,
            });
        });
    }

    return Array.from(series.values()).map((entry) => {
        const f1Values = entry.runs.map((run) => run.f1);
        const tpValues = entry.runs.map((run) => run.tp);
        const fpValues = entry.runs.map((run) => run.fp);
        const fnValues = entry.runs.map((run) => run.fn);

        return {
            ...entry,
            summary: {
                f1: metricSummary(f1Values),
                tp: metricSummary(tpValues),
                fp: metricSummary(fpValues),
                fn: metricSummary(fnValues),
            },
        };
    });
}

function buildSuiteSummary(runArtifactsByName) {
    const suite = {};

    for (const levelName of LEVELS) {
        const rows = runArtifactsByName.map((runArtifacts) => ({
            run: runArtifacts.runName,
            tp: runArtifacts.levels[levelName].tp,
            fp: runArtifacts.levels[levelName].fp,
            fn: runArtifacts.levels[levelName].fn,
            precision: runArtifacts.levels[levelName].precision,
            recall: runArtifacts.levels[levelName].recall,
            f1: runArtifacts.levels[levelName].f1,
        }));

        suite[levelName] = {
            runs: rows.map((row) => ({
                ...row,
                precision: round(row.precision),
                recall: round(row.recall),
                f1: round(row.f1),
            })),
            summary: {
                f1: metricSummary(rows.map((row) => row.f1)),
                precision: metricSummary(rows.map((row) => row.precision)),
                recall: metricSummary(rows.map((row) => row.recall)),
                tp: metricSummary(rows.map((row) => row.tp)),
                fp: metricSummary(rows.map((row) => row.fp)),
                fn: metricSummary(rows.map((row) => row.fn)),
            },
            perPr: buildPerPrSeries(runArtifactsByName, levelName),
        };
    }

    return suite;
}

function toMarkdown(runArtifactsByName, suiteSummary) {
    const lines = [];
    lines.push('# Benchmark Suite Summary');
    lines.push('');
    lines.push(
        `Generated at ${new Date().toISOString()} from ${runArtifactsByName.length} runs.`,
    );
    lines.push('');

    for (const levelName of LEVELS) {
        const level = suiteSummary[levelName];
        const stats = level.summary;
        const unstable = [...level.perPr]
            .sort((a, b) => b.summary.f1.sd - a.summary.f1.sd)
            .slice(0, 5);

        lines.push(`## ${levelName}`);
        lines.push('');
        lines.push(
            `F1 mean=${round(stats.f1.mean)} sd=${round(stats.f1.sd)} min=${round(stats.f1.min)} max=${round(stats.f1.max)} range=${round(stats.f1.range)}`,
        );
        lines.push(
            `Recall mean=${round(stats.recall.mean)} sd=${round(stats.recall.sd)} | Precision mean=${round(stats.precision.mean)} sd=${round(stats.precision.sd)}`,
        );
        lines.push('');
        lines.push('| Run | TP | FP | FN | Precision | Recall | F1 |');
        lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
        for (const row of level.runs) {
            lines.push(
                `| ${row.run} | ${row.tp} | ${row.fp} | ${row.fn} | ${row.precision.toFixed(3)} | ${row.recall.toFixed(3)} | ${row.f1.toFixed(3)} |`,
            );
        }
        lines.push('');
        lines.push('Most unstable PRs:');
        lines.push('');
        lines.push('| Repo | Head | F1 mean | F1 sd | TP range | FP range |');
        lines.push('| --- | --- | ---: | ---: | ---: | ---: |');
        for (const entry of unstable) {
            lines.push(
                `| ${entry.repo} | ${entry.head} | ${entry.summary.f1.mean.toFixed(3)} | ${entry.summary.f1.sd.toFixed(3)} | ${entry.summary.tp.range.toFixed(0)} | ${entry.summary.fp.range.toFixed(0)} |`,
            );
        }
        lines.push('');
    }

    return `${lines.join('\n')}\n`;
}

function printConsoleSummary(suiteSummary) {
    for (const levelName of LEVELS) {
        const stats = suiteSummary[levelName].summary;
        process.stdout.write(
            `${levelName}: F1 mean=${stats.f1.mean.toFixed(3)} sd=${stats.f1.sd.toFixed(3)} range=${stats.f1.min.toFixed(3)}..${stats.f1.max.toFixed(3)} | Recall mean=${stats.recall.mean.toFixed(3)} | Precision mean=${stats.precision.mean.toFixed(3)}\n`,
        );
    }
}

function main() {
    const { runRefs, outputDir } = parseArgs(process.argv);
    if (!runRefs.length) {
        process.stderr.write(
            'Usage: node analyze-runs.js <run-name>... [--output-dir <dir>]\n',
        );
        process.exit(1);
    }

    const runArtifactsByName = runRefs.map(loadRunArtifacts);
    const suiteSummary = buildSuiteSummary(runArtifactsByName);

    printConsoleSummary(suiteSummary);

    if (outputDir) {
        fs.mkdirSync(outputDir, { recursive: true });
        writeJson(
            path.join(outputDir, 'suite-summary.json'),
            {
                generatedAt: new Date().toISOString(),
                runs: runArtifactsByName.map((run) => run.runName),
                suite: suiteSummary,
            },
        );
        fs.writeFileSync(
            path.join(outputDir, 'suite-summary.md'),
            toMarkdown(runArtifactsByName, suiteSummary),
        );
    }
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
    }
}
