// Native CLI transport: page strings travel only in JSON stdin. Global argv,
// environment, config and executable paths never come from a page or repo.
import {execFile} from 'node:child_process';
export class BrowserCLIError extends Error {
    constructor(status) { super('browser exploration CLI ' + status); this.status = status; }
}
export class AgentBrowserClient {
    constructor({endpoint, home, socketDir, signal, exec = execFile}) {
        if (!/^ws:\/\/(?:127\.0\.0\.1|localhost):9222\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(endpoint)) throw new BrowserCLIError('unavailable');
        this.endpoint = endpoint; this.signal = signal; this.exec = exec;
        this.env = {PATH:'/usr/local/bin:/usr/bin:/bin', HOME:home, LANG:'C.UTF-8', AGENT_BROWSER_SOCKET_DIR:socketDir,
            AGENT_BROWSER_NO_WEBMCP:'1', AGENT_BROWSER_NO_VERSION_CHECK:'1', AGENT_BROWSER_PLUGINS:'[]',
            AGENT_BROWSER_NO_XVFB:'1', AGENT_BROWSER_DEFAULT_TIMEOUT:'4000'};
    }
    command(tokens, {timeoutMs = 5_000, cleanup = false, maxBytes = 131_072} = {}) {
        // One command (the content snapshot) may need a larger stdout bound; never past 1 MiB.
        const limit = Math.min(Math.max(1, maxBytes), 1 << 20);
        const input = JSON.stringify([tokens]);
        if (Buffer.byteLength(input) > 65_536) return Promise.reject(new BrowserCLIError('failed'));
        const args = ['--config','/runner/agent-browser.json','--session','explore','--no-webmcp','--json','--idle-timeout','10s','--max-output','8000',
            '--cdp',this.endpoint,'batch','--bail','--omit-command'];
        return new Promise((resolve,reject) => {
            let child;
            try {
                child = this.exec('/usr/local/bin/agent-browser', args, {cwd:'/runner', env:this.env, timeout:Math.max(1,timeoutMs),
                    maxBuffer:limit, ...(cleanup ? {} : {signal:this.signal})}, (error,stdout) => {
                    if (error) { reject(new BrowserCLIError(error.killed || error.name === 'AbortError' ? 'timeout' : 'failed')); return; }
                    try {
                        if (Buffer.byteLength(stdout) > limit) throw new Error();
                        const rows = JSON.parse(stdout);
                        if (!Array.isArray(rows) || rows.length !== 1 || rows[0].success !== true || !rows[0].result || typeof rows[0].result !== 'object') throw new Error();
                        resolve(rows[0].result);
                    } catch { reject(new BrowserCLIError('failed')); }
                });
                child.stdin.on?.('error',()=>{});
                child.stdin.end(input);
            } catch { child?.kill?.(); reject(new BrowserCLIError('unavailable')); }
        });
    }
}
