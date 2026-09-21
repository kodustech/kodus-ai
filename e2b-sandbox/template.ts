import { Template, waitForPort } from 'e2b';

const shadowsocksVersion = '1.24.0';
const downloadUrl = `https://github.com/shadowsocks/shadowsocks-rust/releases/download/v${shadowsocksVersion}/shadowsocks-v${shadowsocksVersion}.x86_64-unknown-linux-gnu.tar.xz`;

// Security rule pass (RunAnalyzersStage). Baked into the image rather than
// installed per review: rule-pack startup already dominates the scan, and
// downloading a binary inside the review would add seconds to every PR.
// Pinned — an unpinned engine changes findings under us between reviews.

// GitHub Actions tools. They only run when a PR touches `.github/workflows`,
// so they cost nothing on most reviews — but the binaries must already be here.

const betterleaksVersion = '1.8.1';
const betterleaksUrl = `https://github.com/betterleaks/betterleaks/releases/download/v${betterleaksVersion}/betterleaks_${betterleaksVersion}_linux_x64.tar.gz`;

const osvScannerVersion = '2.6.0';
const osvScannerUrl = `https://github.com/google/osv-scanner/releases/download/v${osvScannerVersion}/osv-scanner_linux_amd64`;






const installSecurityTools = [
    `wget -O betterleaks.tar.gz ${betterleaksUrl}`,
    'tar -xzf betterleaks.tar.gz betterleaks',
    'sudo mv betterleaks /usr/local/bin/',
    `wget -O osv-scanner ${osvScannerUrl}`,
    'chmod +x osv-scanner',
    'sudo mv osv-scanner /usr/local/bin/',
];

// Transparent proxy: all outbound TCP traffic is routed through the Shadowsocks server
// so git fetch, curl, etc. automatically use the proxy without any extra configuration.
export const kodusTemplate = Template()
    .fromBaseImage()
    .aptInstall(['iptables', 'git', 'ripgrep'])
    .runCmd([
        `wget ${downloadUrl}`,
        'tar -xf shadowsocks-*.tar.xz',
        'sudo mv sslocal /usr/local/bin/',
        ...installSecurityTools,
    ])
    .copy('config.json', 'config.json')
    .copy('iptables-rules.sh', 'iptables-rules.sh', { mode: 0o755 })
    .setStartCmd(
        'sudo sslocal -c config.json --protocol redir -b 0.0.0.0:12345 --daemonize && sudo ./iptables-rules.sh',
        waitForPort(12345),
    );

/**
 * Benchmark-only template: the review sandbox WITHOUT the egress proxy.
 *
 * The proxy exists so production traffic leaves through a fixed IP; a
 * benchmark run has no such requirement, and requiring `config.json` (a
 * gitignored secret) just to measure rule-pack quality blocks the measurement
 * on infrastructure it does not need. Same base and the same analyzer, so what
 * the benchmark exercises is what production runs.
 *
 * Built under its own alias — it must never replace the production template.
 */
export const kodusBenchmarkTemplate = Template()
    .fromBaseImage()
    .aptInstall(['git', 'ripgrep'])
    .runCmd([
        ...installSecurityTools,
    ]);
