// Manual E2B contract probe. No model call; exercises production's reproduction runner.
// node scripts/security-scan/probe-repro-isolation.js [--output=/tmp/repro-isolation.json]
require('dotenv').config({ quiet: true });
require('../../evals/shared/eval-kit').registerTs();
const fs = require('fs');
const { E2BSandboxService } = require('../../libs/sandbox/infrastructure/providers/e2b-sandbox.service.ts');
const { SecurityScanEngine } = require('../../libs/security-scan/application/security-scan-engine.ts');
const { redactSecrets } = require('../../libs/llm/review-error-diagnostics.ts');
const out = process.argv.find(a => a.startsWith('--output='))?.slice('--output='.length);

async function main() {
    const sandbox = await new E2BSandboxService({ get: key => process.env[key] }).createSandboxWithRepo({
        cloneUrl: 'https://github.com/OWASP/NodeGoat.git', authToken: '', branch: 'master', platform: 'GITHUB',
        sandboxMetadata: { stage: 'security-scan-isolation-contract' },
    });
    try {
        // Prove this listener was reachable before the runner blocks the test uid.
        await sandbox.run('nohup python3 -m http.server 18080 --bind 127.0.0.1 >/tmp/isolation-http.log 2>&1 </dev/null &', { asRoot: true, timeoutMs: 10_000 });
        const reachable = await sandbox.run("python3 -c 'import time,urllib.request; time.sleep(1); print(urllib.request.urlopen(\"http://127.0.0.1:18080\").status)'", { asRoot: true, timeoutMs: 10_000 });
        if (reachable.exitCode !== 0) throw new Error('Control listener was not reachable');
        const record = {
            path: 'kodus-isolation-contract.sh', executed: false,
            command: 'bash kodus-isolation-contract.sh',
            content: `set -eu
if curl --noproxy '*' --max-time 3 -fsS http://127.0.0.1:18080 >/dev/null 2>&1; then exit 11; fi
if curl --noproxy '*' --max-time 3 -fsS https://example.com >/dev/null 2>&1; then exit 12; fi
if curl --proxy socks5h://127.0.0.1:1080 --max-time 3 -fsS https://example.com >/dev/null 2>&1; then exit 13; fi
if (echo planted > /home/user/repo/kodus-planted) 2>/dev/null; then exit 14; fi
if (echo planted >> /home/user/.bashrc) 2>/dev/null; then exit 15; fi
if mv /home/user/repo /home/user/replaced 2>/dev/null; then exit 16; fi
echo 'loopback, external network, shared proxy, checkout writes, shell writes and checkout replacement blocked'
`,
        };
        const engine = new SecurityScanEngine();
        const checks = {};
        const failedCommands = [];
        const run = sandbox.run.bind(sandbox);
        sandbox.run = async (command, options) => {
            try { return await run(command, options); }
            catch (error) {
                if (!(command.includes('test -e') && error.exitCode === 1)) failedCommands.push({ phase: command.includes('mount --bind') ? 'checkout mount' : command.includes('unshare --net') ? 'network namespace' : 'reproduction setup',
                    exitCode: error.exitCode, error: redactSecrets(String(error.stderr || error.message)).slice(0, 500) });
                throw error;
            }
        };
        for (const method of ['lockAuditCheckout', 'prepareReproUser']) {
            const original = engine[method].bind(engine);
            engine[method] = async (...args) => { const result = await original(...args); checks[method] = result; return result; };
        }
        await engine.runReproduction({ sandbox, deadlineAt: Date.now() + 120_000 }, 'unknown', record);
        const result = { kind: 'contract', date: new Date().toISOString(), provider: 'e2b',
            modelCalls: 0, controlListenerReachable: reachable.stdout.trim() === '200',
            checks, failedCommands,
            executed: record.executed, passed: record.executed && record.exitCode === 0,
            exitCode: record.exitCode, output: record.output };
        if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
        console.log('ISOLATION_PROBE', JSON.stringify(result));
        if (!result.passed) process.exitCode = 1;
    } finally { await sandbox.cleanup(); }
}
main().catch(error => { console.error(redactSecrets(error.message)); process.exitCode = 2; });
