#!/usr/bin/env node
// What the deterministic analyzers find on the security benchmark, through
// production's RunAnalyzersStage.
//
//   node evals/security-analyzers/run-stage.js [--tranche=vuln|secrets|noise] [--limit=N] [--output=<result.json>]
//
// Each sample is a published vulnerability (scripts/security-benchmark/
// dataset.json): the repository at its vulnerable commit, the diff the review
// is handed, and the lines that are vulnerable. Production's own code does the
// rest: the checkout is the self-hosted sandbox's
// (LocalSandboxService.createSandboxWithRepo at the vulnerable commit), the
// stage routes the tools (AnalyzerToolRouter), selects their files, runs them
// over the sandbox, reads their SARIF (parseAnalyzerSarif) and keeps the
// findings on diff lines. The eval supplies data: the samples, the team's
// settings (the secret scan on), an in-memory organization record, and the
// feature gate over its own catalog (self-hosted audience, beta features on).
//
// betterleaks must be installed (the production sandbox image carries it).
// Exit: 0 measured, 2 not measured (reason printed).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { registerTs } = require('../shared/eval-kit');
const { evalQuestion } = require('../shared/eval-result');

registerTs();
const lib = (p) => require(path.join(__dirname, '../../libs', p));
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));

function notMeasured(reason) {
    console.error(`not measured: ${reason}`);
    process.exit(2);
}

try {
    execFileSync('betterleaks', ['--version'], { stdio: 'ignore' });
} catch {
    notMeasured('betterleaks is not installed on this machine');
}

process.env.BETA_FEATURES = 'true';
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const dataset = require('../../scripts/security-benchmark/dataset.json');
const tranche = args.tranche || 'vuln';
// --ids=<prefix> picks samples by id prefix (the planted secrets are `secret-*`).
const samples = dataset.samples
    .filter((s) => s.tranche === tranche && (!args.ids || s.id.startsWith(String(args.ids))))
    .slice(0, args.limit ? Number(args.limit) : undefined);
const ORG = { organizationId: '00000000-0000-4000-8000-0000000a0a01', teamId: '00000000-0000-4000-8000-0000000a0a02' };

function buildStage() {
    const { RunAnalyzersStage } = lib('code-review/pipeline/stages/run-analyzers.stage.ts');
    const { AnalyzerToolRouter } = lib('code-review/infrastructure/analyzers/analyzer-tool.router.ts');
    const { DeterministicEvidenceGate } = lib('code-review/infrastructure/analyzers/deterministic-evidence.gate.ts');
    const { SecretScanTool } = lib('code-review/infrastructure/analyzers/tools/secret-scan.tool.ts');
    const { DependencyScanTool } = lib('code-review/infrastructure/analyzers/tools/dependency-scan.tool.ts');
    const { FeatureGateService } = lib('feature-gate/application/feature-gate.service.ts');
    // The flag store behind the gate: on for the one feature this eval measures.
    const featureGate = new FeatureGateService({ isFeatureEnabled: async (feature) => feature === 'deterministic-evidence' });
    // The feature is in beta: its catalog entry opens it to organizations on the beta track.
    const organizations = { getReleaseTrack: async () => 'beta' };
    // The patches are in the context already; nothing is withheld by a host.
    const codeManagement = { getFilePatches: async () => [] };
    return new RunAnalyzersStage(new AnalyzerToolRouter(), new DeterministicEvidenceGate(featureGate, organizations), codeManagement, [new SecretScanTool(), new DependencyScanTool()]);
}

// A sample with a published vulnerable commit is cloned from its repository. One
// that is a self-contained fixture (the noise tranche) carries its files, which
// are committed to a local repository the same sandbox then clones.
function localRepoOf(sample) {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'analyzer-fixture-'));
    const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } });
    git('init', '-q', '-b', 'main');
    for (const f of sample.files) {
        if (typeof f.content !== 'string') throw new Error(`${sample.id}: no vulnerable commit and no file content`);
        fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
        fs.writeFileSync(path.join(dir, f.path), f.content);
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'sample');
    return dir;
}

async function checkout(sample) {
    const { LocalSandboxService } = lib('sandbox/infrastructure/providers/local-sandbox.service.ts');
    const { PlatformType } = lib('core/domain/enums/platform-type.enum.ts');
    const sandbox = new LocalSandboxService(undefined);
    if (sample.source?.vulnerableCommit) {
        return sandbox.createSandboxWithRepo({ cloneUrl: `https://github.com/${sample.source.repo}.git`, platform: PlatformType.GITHUB, branch: 'main', checkoutSha: sample.source.vulnerableCommit });
    }
    const dir = localRepoOf(sample);
    try {
        return await sandbox.createSandboxWithRepo({ cloneUrl: dir, platform: PlatformType.GITHUB, branch: 'main' });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function runSample(stage, sample) {
    const sandbox = await checkout(sample);
    try {
        const changedFiles = sample.files.map((f) => ({ filename: f.path, status: 'modified', patch: f.patch }));
        const context = {
            organizationAndTeamData: ORG,
            pullRequest: { number: 1 },
            changedFiles,
            codeReviewConfig: { deterministicEvidence: { tools: { secrets: true } } },
            sandboxHandle: sandbox,
        };
        const out = await stage.execute(context);
        return { findings: out.analyzerFindings || [], failures: out.analyzerFailures || [], routing: out.analyzerRouting || [] };
    } finally {
        await sandbox.cleanup();
    }
}

const detects = (sample, findings) =>
    (sample.expected || []).some((e) => findings.some((f) => f.path === e.path && (e.lines || []).some((l) => l >= f.startLine && l <= f.endLine)));

async function main() {
    const stage = buildStage();
    const cases = [];
    let errored = 0;
    for (const sample of samples) {
        try {
            // eslint-disable-next-line no-await-in-loop
            const { findings, failures, routing } = await runSample(stage, sample);
            if (failures.length) throw new Error(`a tool failed: ${JSON.stringify(failures).slice(0, 160)}`);
            // A stage that never ran the scan is not a clean sample.
            // Production's own file selection may leave the scan nothing to read
            // (a template file): that is quiet. Any other reason is a wiring break.
            const scan = routing.find((r) => r.toolId === 'secrets');
            if (!scan || (!scan.run && scan.reason !== 'no-matching-files')) throw new Error(`the stage did not run the secret scan: ${JSON.stringify(routing).slice(0, 200)}`);
            const ok = tranche === 'noise' ? findings.length === 0 : detects(sample, findings);
            cases.push({ id: sample.id, checks: tranche === 'noise' ? `Stays quiet on ${sample.summary}`.slice(0, 160) : `Flags ${sample.cweLabel}: ${sample.summary}`.slice(0, 160), hits: ok ? 1 : 0, total: 1, detail: findings.slice(0, 5).map((f) => ({ what: `${f.ruleId} ${f.path}:${f.startLine}`, ok })) });
        } catch (error) {
            errored += 1;
            console.error(`  ${sample.id}: ${String(error.message || error).slice(0, 200)}`);
            cases.push({ id: sample.id, checks: String(sample.summary).slice(0, 160), hits: 0, total: 0, unmeasured: true });
        }
    }
    const hits = cases.reduce((n, c) => n + c.hits, 0);
    const total = cases.reduce((n, c) => n + c.total, 0);
    console.log(`${tranche}: ${hits}/${total} ${tranche === 'noise' ? 'quiet' : 'detected'} · ${errored} of ${samples.length} did not measure`);
    if (args.output) {
        fs.writeFileSync(args.output, `${JSON.stringify({ eval: 'security-analyzers', question: evalQuestion('evals/security-analyzers'), model: 'none', runs: 1, metric: { name: tranche === 'noise' ? 'of noise samples left quiet' : 'of vulnerabilities flagged by an analyzer', value: total ? hits / total : null, floor: null, baseline: null }, cases, tokens: {}, infra: { errored, total: samples.length } }, null, 2)}\n`);
    }
    if (errored > samples.length * 0.05) notMeasured(`${errored} of ${samples.length} samples failed (see above)`);
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(2); });
