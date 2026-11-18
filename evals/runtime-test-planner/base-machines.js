// What the base machine answers to the planner's shell commands
// (exec_on_base, and the 2-turn loop's `explore`). Production runs them on the
// claimed machine through the cell; the eval cannot boot one per case, so each
// environment answers from what its image holds. Every command and whether a
// recording answered it go into the result: an unrecorded command is visible,
// never a silent success.
//
// grafana: the image .kodus/Dockerfile.backend builds on the fork (alpine 3.20,
// WORKDIR /grafana, only bin/, conf/ and public/ copied, busybox, no curl, no
// Go toolchain, no source). /api/health answers as the server on SQLite does.
// node and python: the synthetic apps of fixtures/, whose images run from the
// source they copy, so a read of a base file answers with it.

const ok = (stdout) => ({ exitCode: 0, stdout, stderr: '' });
const fail = (exitCode, stderr, stdout = '') => ({ exitCode, stdout, stderr });

const GRAFANA_TREE = {
    '': ['bin', 'conf', 'public'],
    bin: ['linux-amd64'],
    'bin/linux-amd64': ['grafana'],
    conf: ['defaults.ini', 'ldap.toml', 'ldap_multiple.toml', 'provisioning', 'sample.ini'],
    'conf/provisioning': ['access-control', 'alerting', 'dashboards', 'datasources', 'plugins'],
    public: ['api-merged.json', 'app', 'build', 'emails', 'fonts', 'img', 'locales', 'openapi3.json', 'views'],
};

const GRAFANA_HEALTH = '{\n  "database": "ok",\n  "version": "12.3.0-pre",\n  "commit": "ee53311688d"\n}';

const DEFAULTS_INI = [
    '[server]',
    'protocol = http',
    'http_addr =',
    'http_port = 3000',
    'root_url = %(protocol)s://%(domain)s:%(http_port)s/',
    '',
    '[database]',
    'type = sqlite3',
    'path = grafana.db',
    '',
    '[auth.anonymous]',
    'enabled = false',
    'hide_version = false',
].join('\n');

function grafanaDir(arg) {
    const p = String(arg || '')
        .replace(/^\/grafana\/?/, '')
        .replace(/^\.\/?/, '')
        .replace(/\/+$/, '');
    return p;
}

/** One environment: (command) → {exitCode, stdout, stderr, recorded}. */
const MACHINES = {
    grafana: [
        [/\bcurl\b/, () => fail(127, 'sh: curl: not found')],
        [/\bwget\b.*(localhost|127\.0\.0\.1|0\.0\.0\.0):3000\/api\/health\b/, () => ok(GRAFANA_HEALTH)],
        [/\bwget\b.*(localhost|127\.0\.0\.1|0\.0\.0\.0):3000\/(healthz|api\/healthz)?(\s|'|"|$)/, () => ok('Ok')],
        [/\bwget\b.*:3000\/api\//, () => fail(1, 'wget: server returned error: HTTP/1.1 401 Unauthorized')],
        [/\b(go|make|node|npm|yarn)\b(\s|$)/, (c) => fail(127, `sh: ${/\b(go|make|node|npm|yarn)\b/.exec(c)[1]}: not found`)],
        [/\b(cat|head|tail|sed|less|grep)\b[^|;&]*\b(pkg|apps|public\/app|src)\/\S*\.(go|ts|tsx)\b/, (c) => {
            const f = /\b((?:pkg|apps|src)\/\S+?\.(?:go|ts|tsx))\b/.exec(c);
            return fail(1, `cat: can't open '${f ? f[1] : 'file'}': No such file or directory`);
        }],
        [/\bgrep\b.*-r/, () => ok('')],
        [/\bfind\b.*\.go\b/, () => ok('')],
        [/\bfind\b/, () => ok(Object.entries(GRAFANA_TREE).flatMap(([d, es]) => es.map((e) => `./${d ? `${d}/` : ''}${e}`)).join('\n'))],
        [/\bcat\b.*conf\/defaults\.ini/, () => ok(DEFAULTS_INI)],
        [/\bgrafana\b.*(-v\b|--version|\bversion\b)/, () => ok('grafana version 12.3.0-pre (commit: ee53311688d, branch: main)')],
        [/\bps\b/, () => ok('PID   USER     TIME  COMMAND\n    1 root      0:09 /grafana/bin/linux-amd64/grafana server --homepath /grafana\n   42 root      0:00 ps')],
        [/\b(netstat|ss)\b/, () => ok('Proto Recv-Q Send-Q Local Address           Foreign Address         State\ntcp        0      0 :::3000                 :::*                    LISTEN')],
        [/^\s*(env|printenv)\b/, () => ok('HOSTNAME=grafana\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nGF_ANALYTICS_REPORTING_ENABLED=false\nGF_ANALYTICS_CHECK_FOR_UPDATES=false\nGF_PLUGINS_PREINSTALL_DISABLED=true\nHOME=/root')],
        [/^\s*pwd\s*$/, () => ok('/grafana')],
        [/^\s*(uname|cat \/etc\/os-release)/, () => ok('NAME="Alpine Linux"\nVERSION_ID=3.20.3')],
        [/\bls\b/, (c) => {
            const arg = c.replace(/^.*?\bls\b/, '').split(/[|;&]/)[0].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'))[0];
            if (arg === '/') return ok('bin\ndev\netc\ngrafana\nhome\nlib\nmedia\nmnt\nopt\nproc\nroot\nrun\nsbin\nsrv\nsys\ntmp\nusr\nvar');
            const d = grafanaDir(arg);
            if (GRAFANA_TREE[d]) return ok(GRAFANA_TREE[d].join('\n'));
            return fail(1, `ls: ${arg}: No such file or directory`);
        }],
    ],
};

/** A synthetic app's machine: its source is in the image, at /app. */
function sourceMachine(source, { port }) {
    const rel = (p) => String(p || '').replace(/^\/app\/?/, '').replace(/^\.\/?/, '').replace(/\/+$/, '');
    return [
        [/\bcurl\b/, () => fail(127, 'sh: curl: not found')],
        [new RegExp(`\\bwget\\b.*:${port}\\b`), () => fail(1, 'wget: server returned error: HTTP/1.1 404 Not Found')],
        [/\b(cat|head|tail)\s+(?:-\S+\s+)*(\S+)/, (c) => {
            const p = rel(/\b(?:cat|head|tail)\s+(?:-\S+\s+)*(\S+)/.exec(c)[1]);
            const text = source.readBase(p);
            return text === null ? fail(1, `cat: can't open '${p}': No such file or directory`) : ok(text.slice(0, 4_000));
        }],
        [/\bfind\b/, () => ok(source.baseFiles().map((f) => `./${f}`).join('\n'))],
        [/\bls\b/, (c) => {
            const arg = rel(c.replace(/^.*?\bls\b/, '').split(/[|;&]/)[0].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'))[0]);
            const entries = [...new Set(source.baseFiles().filter((f) => !arg || f.startsWith(`${arg}/`)).map((f) => f.slice(arg ? arg.length + 1 : 0).split('/')[0]))];
            return entries.length ? ok(entries.sort().join('\n')) : fail(1, `ls: ${arg}: No such file or directory`);
        }],
        [/^\s*pwd\s*$/, () => ok('/app')],
    ];
}

/** The machine of a case: (command) → the step result fields, plus whether a recording answered. */
function machineFor(testCase, source) {
    const rules = testCase.machine === 'grafana' ? MACHINES.grafana : sourceMachine(source, { port: testCase.targets[0].port });
    return (command) => {
        for (const [re, answer] of rules) if (re.test(command)) return { ...answer(command), recorded: true };
        return { ...fail(127, `sh: ${command.trim().split(/\s+/)[0]}: not found`), recorded: false };
    };
}

module.exports = { machineFor };
