// No paid model. Exhaust the planner's HTTP 429 retries while the remaining
// production engine runs against the ordinary scripted wiring model.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { startFakeLlmServer } = require('../shared/fake-llm-server');

async function main() {
    const output = process.argv.find(a => a.startsWith('--output='))?.slice(9)
        ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scan-429-')), 'contract.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const rawOutput = `${output}.raw.json`;
    const fake = await startFakeLlmServer();
    let injected = 0;
    const proxy = http.createServer(async (req, res) => {
        try {
            let body = '';
            for await (const part of req) body += part;
            if (body.includes('You plan a security audit of a repository')) {
                injected++;
                res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
                res.end(JSON.stringify({ error: { message: 'Deliberate planner rate limit.' } }));
                return;
            }
            const reply = await fetch(`${fake.url}/chat/completions`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body,
            });
            res.writeHead(reply.status, { 'content-type': reply.headers.get('content-type') ?? 'application/json' });
            res.end(Buffer.from(await reply.arrayBuffer()));
        } catch {
            res.writeHead(500);
            res.end();
        }
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    try {
        const log = fs.openSync(`${output}.log`, 'w');
        let exitCode;
        try {
            const child = spawn(process.execPath, [
                path.join(__dirname, 'run.js'), '--model=eval-fake', '--set=wiring',
                `--output=${rawOutput}`,
            ], { cwd: path.join(__dirname, '../..'), stdio: ['ignore', log, log], env: {
                ...process.env, API_CRYPTO_KEY: '0'.repeat(64),
                DOTENV_CONFIG_PATH: process.platform === 'win32' ? 'NUL' : '/dev/null',
                EVAL_FAKE_LLM_KEY: 'scripted-local-model',
                EVAL_FAKE_LLM_URL: `http://127.0.0.1:${proxy.address().port}/v1`,
            } });
            exitCode = await new Promise((resolve, reject) => {
                child.once('error', reject);
                child.once('exit', resolve);
            });
        } finally { fs.closeSync(log); }
        const raw = JSON.parse(fs.readFileSync(rawOutput));
        const checks = {
            injectedRealHttp429: injected > 0,
            engineContinued: raw.cases.some(c => c.coverage.done > 0),
            recordsExhaustedCalls: raw.cases.some(c => c.requestFailures?.rateLimited > 0),
            recordsInfrastructureFailure: raw.infra.errored > 0,
            savesCompletedCaseCheckpoint: fs.existsSync(`${rawOutput}.partial`),
            refusesCleanMeasurement: exitCode === 2,
        };
        const result = { kind: 'contract', paidModelCalls: 0, injectedHttpResponses: injected, checks, passed: Object.values(checks).every(Boolean) };
        fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
        console.log(JSON.stringify(result));
        process.exitCode = result.passed ? 0 : 1;
    } finally {
        await new Promise(resolve => proxy.close(resolve));
        await fake.close();
    }
}
main().catch(error => { console.error(error.stack); process.exitCode = 2; });
