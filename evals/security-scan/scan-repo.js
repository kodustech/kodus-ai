// One security scan of one repository at a commit, the way the job runs it:
// production's SecurityScanEngine.run on production's sandbox, the model routed
// like the org's BYOK model, the job's spend meter. Shared by the evals that
// score a scan (run.js on VulnGym, realvuln.js on RealVuln) so they measure
// the same code. The caller registers TypeScript (eval-kit registerTs) first.
const fs = require('fs');
const path = require('path');

const { evalPermissionService, EVAL_ORG } = require('../shared/model-route');
const { mirrorFor, inlineMirror } = require('../shared/repo-mirror');

const LIBS = path.join(__dirname, '../../libs');
const lib = (p) => require(path.join(LIBS, p));

// The pricing the job reads (catalog, no org override), with no shared cache.
function pricingResolver() {
    const { PricingResolver } = lib('analytics/application/use-cases/usage/pricing-resolver.ts');
    const { TokenPricingUseCase } = lib('analytics/application/use-cases/usage/token-pricing.use-case.ts');
    const memory = new Map();
    const cache = {
        getFromCache: async (k) => memory.get(k),
        addToCache: async (k, v) => void memory.set(k, v),
        removeFromCache: async (k) => void memory.delete(k),
    };
    return new PricingResolver(new TokenPricingUseCase(cache));
}

/** `c`: { repo: 'owner/name', commit } or { files } for a repository written for the case. */
async function openSandbox(c, sandboxKind) {
    const { LocalSandboxService } = lib('sandbox/infrastructure/providers/local-sandbox.service.ts');
    if (c.files) {
        // A repository written for the case, cloned like any other.
        const mirror = await inlineMirror(c.files);
        const sandbox = await new LocalSandboxService(undefined).createSandboxWithRepo({ cloneUrl: mirror.cloneUrl, authToken: '', branch: mirror.branch, platform: 'github' });
        const cleanup = sandbox.cleanup;
        sandbox.cleanup = async () => {
            await cleanup();
            await mirror.cleanup();
        };
        return sandbox;
    }
    const params = { authToken: '', branch: '', platform: 'github', checkoutSha: c.commit, sandboxMetadata: { stage: 'eval-security-scan' } };
    if (sandboxKind === 'e2b') {
        const { E2BSandboxService } = lib('sandbox/infrastructure/providers/e2b-sandbox.service.ts');
        const env = { ...require('dotenv').parse(fs.existsSync(path.join(__dirname, '../../.env')) ? fs.readFileSync(path.join(__dirname, '../../.env')) : ''), ...process.env };
        // E2B clones from GitHub itself: a file:// mirror is on this machine.
        return new E2BSandboxService({ get: (k) => env[k] }).createSandboxWithRepo({ ...params, cloneUrl: `https://github.com/${c.repo}.git` });
    }
    const cloneUrl = await mirrorFor({ repo: c.repo, headSha: c.commit });
    return new LocalSandboxService(undefined).createSandboxWithRepo({ ...params, cloneUrl });
}

/**
 * Scans `c` within `budgetUsd` and returns the engine's result, the meter's
 * spend and `shipped`: one finding per issue identity, as the job stores them.
 */
async function scanRepository({ c, route, pricing, budgetUsd, sandbox: sandboxKind = 'local' }) {
    const { SecurityScanEngine } = lib('security-scan/application/security-scan-engine.ts');
    const { resolveScanModel } = lib('security-scan/application/scan-model.ts');
    const { ScanBudgetMeter } = lib('security-scan/domain/budget-meter.ts');
    const { computeScanFingerprint } = lib('issues/domain/scan-fingerprint.ts');

    const sandbox = await openSandbox(c, sandboxKind);
    try {
        const { model, rates } = await resolveScanModel({
            organizationAndTeamData: EVAL_ORG,
            permissionValidationService: evalPermissionService(route.storedConfig),
            pricingResolver: pricing,
        });
        const meter = new ScanBudgetMeter(rates ? { maxUsd: budgetUsd } : { maxTokens: budgetUsd * 2_000_000 }, rates);
        const repositoryId = c.repo ?? c.id;
        const result = await new SecurityScanEngine().run({
            organizationId: EVAL_ORG.organizationId,
            teamId: EVAL_ORG.teamId,
            repositoryId,
            repositoryFullName: repositoryId,
            sandbox,
            model,
            meter,
            maxUnits: 400,
            reproduce: sandboxKind === 'e2b',
        });

        // What ships: the job stores one issue per fingerprint, so findings
        // that share one are one issue (the first is the one stored).
        const shipped = [];
        const seen = new Set();
        for (const f of result.findings) {
            const fp = computeScanFingerprint({ repositoryPlatform: 'github', repositoryId, vulnerabilityClass: f.vulnerabilityClass, filePath: f.filePath, symbol: f.symbol, cwe: f.cwe, appWide: f.appWide });
            if (seen.has(fp)) continue;
            seen.add(fp);
            shipped.push(f);
        }
        return { result, shipped, spend: meter.snapshot() };
    } finally {
        await sandbox.cleanup().catch(() => undefined);
    }
}

module.exports = { pricingResolver, scanRepository };
