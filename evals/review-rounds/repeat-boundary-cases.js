// Keep each reviewed change fixed. Only the earlier comment changes between
// the repeat and the new-site case. The empty-history twin measures recall.
const { filesBetween } = require('../shared/repo-mirror');

function historyCases({ id, title, previous, repo, rule, target, other, golden }) {
    const record = {
        suggestionId: 'round-a-rule-comment',
        label: 'kody_rules',
        brokenKodyRulesIds: [rule.uuid],
        decidedAt: '2026-10-01T10:00:00Z',
        outcome: 'pending',
    };
    return [
        ['repeat', target, 'not_deliver'],
        ['new-site', other, 'deliver'],
        ['no-history', null, 'deliver'],
    ].map(([variant, comment, expect]) => ({
        id: `${id}-${variant}`,
        family: 'rounds',
        agent: 'kody-rules',
        sandbox: 'alive',
        prBase: {},
        prTitle: title,
        repo,
        changedFiles: filesBetween(previous, repo),
        kodyRules: [rule],
        previousDecisions: comment ? [{ ...record, ...comment }] : [],
        claims: [{ id: `${id}-${variant}`, ruleId: rule.uuid, golden, truth: 'true', expect }],
    }));
}

const exportsBefore = {
    'src/csv.ts': 'export function exportCsv() { return { format: "csv" }; }\n',
    'src/pdf.ts': 'export function exportPdf() { return { format: "pdf" }; }\n',
    'tests/export.spec.ts': 'it("recognizes exports", () => expect("export").toBeTruthy());\n',
};
const changelogBefore = {
    'src/commands.ts': 'export const commands = { pack: "pack an archive", unpack: "unpack an archive" };\n',
    'CHANGELOG.md': '# Unreleased\n\nUpdated CLI help.\n',
};
const jobsBefore = {
    'src/worker.ts': 'export function startWorker() {\n    console.log("starting");\n}\n',
    'src/scheduler.ts': 'export function startScheduler() {\n    console.log("starting");\n}\n',
    'src/log.ts': 'export const log = (event: string) => process.stdout.write(JSON.stringify({ event }));\n',
};
module.exports = [
    ...historyCases({
        id: 'B1', title: 'feat: include the PDF media type',
        previous: exportsBefore,
        repo: { ...exportsBefore, 'src/pdf.ts': 'export function exportPdf() { return { format: "pdf", mediaType: "application/pdf" }; }\n' },
        rule: { uuid: 'eval-export-coverage', scope: 'pull-request', title: 'Each changed exporter needs a format test', rule: 'When an exporter changes, require a test that calls that exporter and checks its returned format. A generic export smoke test is insufficient.' },
        target: { suggestionContent: 'PDF output is unprotected: no assertion exercises exportPdf and checks its format.' },
        other: { suggestionContent: 'CSV output is unprotected: no assertion exercises exportCsv and checks its format.' },
        golden: 'The PDF exporter lacks a test calling exportPdf and asserting the returned format.',
    }),
    ...historyCases({
        id: 'B2', title: 'feat(cli): change unpack help',
        previous: changelogBefore,
        repo: { ...changelogBefore, 'src/commands.ts': changelogBefore['src/commands.ts'].replace('unpack an archive', 'extract all archive contents') },
        rule: { uuid: 'eval-cli-changelog', scope: 'pull-request', title: 'Document each changed CLI command', rule: 'When the help text of a CLI command changes, the Unreleased section of CHANGELOG.md must name that exact command in backticks and describe the change.' },
        target: { suggestionContent: 'The release notes never mention the updated help for `unpack`.' },
        other: { suggestionContent: 'The release notes never mention the updated help for `pack`.' },
        golden: 'CHANGELOG.md does not document the help change for the unpack command in Unreleased.',
    }),
    ...historyCases({
        id: 'B3', title: 'feat: log the scheduler component at startup',
        previous: jobsBefore,
        repo: { ...jobsBefore, 'src/scheduler.ts': jobsBefore['src/scheduler.ts'].replace('console.log("starting")', 'console.log("starting scheduler")') },
        rule: { uuid: 'eval-job-log', scope: 'file', title: 'Use the structured logger', rule: 'Use the shared log function from src/log.ts in each startup function. Replace direct console.log calls.' },
        target: { relevantFile: 'src/scheduler.ts', relevantLinesStart: 2, relevantLinesEnd: 2, suggestionContent: 'startScheduler bypasses structured logging at startup. Use the shared logger.' },
        other: { relevantFile: 'src/worker.ts', relevantLinesStart: 2, relevantLinesEnd: 2, suggestionContent: 'startWorker bypasses structured logging at startup. Use the shared logger.' },
        golden: 'startScheduler logs directly with console.log instead of using the shared structured logger.',
    }),
];
