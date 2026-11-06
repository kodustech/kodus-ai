import { Template, waitForPort } from 'e2b';

const shadowsocksVersion = '1.24.0';
const downloadUrl = `https://github.com/shadowsocks/shadowsocks-rust/releases/download/v${shadowsocksVersion}/shadowsocks-v${shadowsocksVersion}.x86_64-unknown-linux-gnu.tar.xz`;

// Deterministic evidence pass (RunAnalyzersStage). Baked into the image rather
// than installed per review: downloading a binary inside the review would add
// seconds to every PR. Pinned — an unpinned scanner changes findings under us
// between reviews, and the versions here must match docker/Dockerfile so the
// E2B and local sandboxes cannot drift apart.
//
// x86_64 only, which is what E2B runs. The worker image builds both arches.

const betterleaksVersion = '1.8.1';
const betterleaksUrl = `https://github.com/betterleaks/betterleaks/releases/download/v${betterleaksVersion}/betterleaks_${betterleaksVersion}_linux_x64.tar.gz`;

const osvScannerVersion = '2.6.0';
const osvScannerUrl = `https://github.com/google/osv-scanner/releases/download/v${osvScannerVersion}/osv-scanner_linux_amd64`;

// Structural search for custom review agents (the `astGrep` tool). Only the
// `ast-grep` binary is installed: on Linux `sg` is util-linux's setgroups.
const astGrepVersion = '0.45.3';
const astGrepUrl = `https://github.com/ast-grep/ast-grep/releases/download/${astGrepVersion}/app-x86_64-unknown-linux-gnu.zip`;

// osv-scanner queries the OSV.dev API at run time, so it needs egress from the
// sandbox — through the Shadowsocks proxy on the production template below.
const installSecurityTools = [
    `wget -O betterleaks.tar.gz ${betterleaksUrl}`,
    'tar -xzf betterleaks.tar.gz betterleaks',
    'sudo mv betterleaks /usr/local/bin/',
    `wget -O osv-scanner ${osvScannerUrl}`,
    'chmod +x osv-scanner',
    'sudo mv osv-scanner /usr/local/bin/',
    `wget -O ast-grep.zip ${astGrepUrl}`,
    'unzip -o ast-grep.zip ast-grep',
    'chmod +x ast-grep',
    'sudo mv ast-grep /usr/local/bin/',
];

// Transparent proxy: all outbound TCP traffic is routed through the Shadowsocks server
// so git fetch, curl, etc. automatically use the proxy without any extra configuration.
export const kodusTemplate = Template()
    .fromBaseImage()
    .aptInstall(['ca-certificates', 'iptables', 'git', 'ripgrep', 'unzip'])
    .runCmd([
        `wget ${downloadUrl}`,
        'tar -xf shadowsocks-*.tar.xz',
        'sudo mv sslocal /usr/local/bin/',
        ...installSecurityTools,
    ])
    // The config holds the proxy's password: root-only, outside the review
    // user's home (ROOT_ONLY_DIR/PROXY_CONFIG_FILE in review-user-privileges).
    .copy('config.json', '/etc/kodus/proxy.json', { user: 'root', mode: 0o600 })
    .copy('iptables-rules.sh', 'iptables-rules.sh', { mode: 0o755 })
    .setStartCmd(
        'sudo sslocal -c /etc/kodus/proxy.json --protocol redir -b 0.0.0.0:12345 --daemonize && sudo ./iptables-rules.sh',
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
    .aptInstall(['ca-certificates', 'git', 'ripgrep', 'unzip'])
    .runCmd([...installSecurityTools]);

/**
 * Benchmark template for the code-execution experiment: the benchmark
 * sandbox plus the runtimes of the benchmark's repositories (node and python
 * come with the base image; ruby, go and java added), so an agent can run a
 * snippet of the changed code, and fast-check / Hypothesis for the fuzz
 * agent. Built under its own alias, never production.
 */
// Property-based fuzzers for the fuzz agent, in a fixed prefix the runner
// points NODE_PATH / PYTHONPATH at (gap-agents.ts FUZZ_LIB_DIR).
// Go uses the standard library's testing/quick; Java runs jqwik properties
// through the JUnit console launcher; Ruby uses rantly.
const fastCheckVersion = '3.23.2';
const hypothesisVersion = '6.112.0';
const jqwikVersion = '1.9.2';
const junitConsoleVersion = '1.11.4';
const rantlyVersion = '2.0.0';
const maven = 'https://repo1.maven.org/maven2';
const javaFuzzJars = [
    `${maven}/net/jqwik/jqwik-api/${jqwikVersion}/jqwik-api-${jqwikVersion}.jar`,
    `${maven}/net/jqwik/jqwik-engine/${jqwikVersion}/jqwik-engine-${jqwikVersion}.jar`,
    `${maven}/org/opentest4j/opentest4j/1.3.0/opentest4j-1.3.0.jar`,
    `${maven}/org/apiguardian/apiguardian-api/1.1.2/apiguardian-api-1.1.2.jar`,
];

export const kodusBenchmarkExecTemplate = Template()
    .fromBaseImage()
    .aptInstall(['ca-certificates', 'git', 'ripgrep', 'unzip', 'ruby', 'golang-go', 'default-jdk-headless'])
    .runCmd([
        ...installSecurityTools,
        'sudo mkdir -p /opt/kodus-fuzz/py',
        `sudo npm install --prefix /opt/kodus-fuzz fast-check@${fastCheckVersion}`,
        `sudo python3 -m pip install --target /opt/kodus-fuzz/py hypothesis==${hypothesisVersion}`,
        'sudo mkdir -p /opt/kodus-fuzz/java',
        ...javaFuzzJars.map((url) => `sudo wget -q -P /opt/kodus-fuzz/java ${url}`),
        `sudo wget -q -O /opt/kodus-fuzz/junit-console.jar ${maven}/org/junit/platform/junit-platform-console-standalone/${junitConsoleVersion}/junit-platform-console-standalone-${junitConsoleVersion}.jar`,
        `sudo gem install --no-document rantly -v ${rantlyVersion}`,
    ]);
