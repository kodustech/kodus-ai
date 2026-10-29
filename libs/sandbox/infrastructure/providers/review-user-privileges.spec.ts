import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    buildDropReviewUserPrivilegesScript,
    confirmsPrivilegesDropped,
    PRIVILEGES_DROPPED_MARKER,
    ROOT_SAFE_PATH_LINE,
} from './review-user-privileges';

/**
 * Runs the lockdown script under bash with the system tools it calls
 * replaced by stubs, so what it does (and what it refuses to confirm) is
 * checked, not only what it says.
 *
 * - `sudo -u <user> -- cmd` runs cmd; a bare `sudo -n true` (the review
 *   user's own sudo) exits with $SELF_SUDO_RC;
 * - `find` lists the set-id files still present in $SETID_FILE;
 * - `chmod ug-s <f>` removes <f> from that list;
 * - `getent passwd` gives the review user a home under the temp dir, where
 *   `homeConfig` is the template's proxy config;
 * - `test -r <f>` from the review user holds for the files in $READABLE.
 */
const run = (opts: {
    selfSudoRc: number;
    setId: string[];
    chmodWorks?: boolean;
    homeConfig?: string;
    homeConfigIsLink?: boolean;
    readable?: string[];
}) => {
    const dir = mkdtempSync(join(tmpdir(), 'kdrop-'));
    const log = join(dir, 'calls.log');
    const setIdFile = join(dir, 'setid');
    const home = join(dir, 'home');
    const rootOnly = join(dir, 'kodus');
    writeFileSync(log, '');
    writeFileSync(setIdFile, opts.setId.map((f) => `${f}\n`).join(''));
    mkdirSync(home);
    if (opts.homeConfig !== undefined) {
        if (opts.homeConfigIsLink) {
            writeFileSync(join(dir, 'elsewhere.json'), opts.homeConfig);
            symlinkSync(join(dir, 'elsewhere.json'), join(home, 'config.json'));
        } else {
            writeFileSync(join(home, 'config.json'), opts.homeConfig);
        }
    }
    const stub = (name: string, body: string) => {
        const path = join(dir, name);
        writeFileSync(
            path,
            `#!/bin/bash\necho "${name} $*" >> '${log}'\n${body}\n`,
        );
        chmodSync(path, 0o755);
    };
    stub(
        'sudo',
        [
            '[ "${1:-}" = "-n" ] && shift',
            // env: like sudo, run a program, never a bash builtin.
            'if [ "${1:-}" = "-u" ]; then shift 2; [ "${1:-}" = "--" ] && shift; env "$@"; exit $?; fi',
            'exit "$SELF_SUDO_RC"',
        ].join('\n'),
    );
    stub('id', 'echo 1000');
    stub('getent', `echo "user:x:1000:1000::${home}:/bin/bash"`);
    stub(
        'install',
        'mkdir -p "$(dirname "${@: -1}")"; cp "${@: -2:1}" "${@: -1}"',
    );
    stub('chown', 'exit 0');
    stub(
        'test',
        `[ "$1" = -r ] || exit 2; for f in $READABLE; do [ "$f" = "$2" ] && exit 0; done; exit 1`,
    );
    stub('gpasswd', 'exit 0');
    stub(
        'find',
        `case "$1" in /usr) cat '${setIdFile}';; esac; exit 0`,
    );
    stub(
        'chmod',
        `[ "$CHMOD_WORKS" = 1 ] || exit 1; f="\${@: -1}"; grep -vxF "$f" '${setIdFile}' > '${setIdFile}.n' || true; mv '${setIdFile}.n' '${setIdFile}'`,
    );
    try {
        const script = buildDropReviewUserPrivilegesScript('user', rootOnly);
        expect(script).toContain(ROOT_SAFE_PATH_LINE);
        const result = spawnSync(
            'bash',
            ['-c', script.split(ROOT_SAFE_PATH_LINE).join(':')],
            {
                env: {
                    PATH: `${dir}:/usr/bin:/bin`,
                    SELF_SUDO_RC: String(opts.selfSudoRc),
                    CHMOD_WORKS: opts.chmodWorks === false ? '0' : '1',
                    READABLE: (opts.readable ?? [])
                        .map((f) => f.replace('<root-only>', rootOnly))
                        .join(' '),
                } as unknown as NodeJS.ProcessEnv,
                encoding: 'utf8',
            },
        );
        return {
            ...result,
            calls: readFileSync(log, 'utf8').split('\n').filter(Boolean),
            homeConfigLeft: existsSync(join(home, 'config.json')),
            rootOnlyConfig: existsSync(join(rootOnly, 'proxy.json'))
                ? readFileSync(join(rootOnly, 'proxy.json'), 'utf8')
                : null,
            left: existsSync(setIdFile)
                ? readFileSync(setIdFile, 'utf8').split('\n').filter(Boolean)
                : [],
        };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

describe('review user lockdown script', () => {
    it('clears every set-id bit, leaves the admin groups and confirms', () => {
        const result = run({
            selfSudoRc: 1,
            setId: ['/usr/bin/sudo', '/usr/bin/su', '/usr/bin/passwd'],
        });
        expect(result.left).toEqual([]);
        expect(result.calls).toEqual(
            expect.arrayContaining([
                'chmod ug-s /usr/bin/sudo',
                'chmod ug-s /usr/bin/su',
                'gpasswd -d user sudo',
            ]),
        );
        expect(result.stdout).toContain(PRIVILEGES_DROPPED_MARKER);
        expect(result.status).toBe(0);
        expect(
            confirmsPrivilegesDropped({
                exitCode: result.status ?? -1,
                stdout: result.stdout,
            }),
        ).toBe(true);
    });

    it('refuses to confirm while the review user can still use sudo', () => {
        const result = run({ selfSudoRc: 0, setId: [] });
        expect(result.status).toBe(5);
        expect(result.stderr).toContain('can still use sudo');
        expect(result.stdout).not.toContain(PRIVILEGES_DROPPED_MARKER);
    });

    it('refuses to confirm while a set-id file is left', () => {
        const result = run({
            selfSudoRc: 1,
            setId: ['/usr/bin/pkexec'],
            chmodWorks: false,
        });
        expect(result.calls).toContain('chmod ug-s /usr/bin/pkexec');
        expect(result.status).toBe(5);
        expect(result.stderr).toContain('set-id file left: /usr/bin/pkexec');
        expect(result.stdout).not.toContain(PRIVILEGES_DROPPED_MARKER);
    });
});

describe('review user lockdown script — proxy config', () => {
    const CONFIG = '{"server":"192.0.2.1","password":"FAKE_PROXY_PASSWORD"}';

    it('moves the template proxy config out of the review user home', () => {
        const result = run({ selfSudoRc: 1, setId: [], homeConfig: CONFIG });
        expect(result.homeConfigLeft).toBe(false);
        expect(result.rootOnlyConfig).toBe(CONFIG);
        expect(result.calls).toEqual(
            expect.arrayContaining([
                expect.stringMatching(/^install -D -m 600 -o root -g root /),
                expect.stringMatching(/^chmod 600 .*proxy\.json$/),
            ]),
        );
        expect(result.stdout).toContain(PRIVILEGES_DROPPED_MARKER);
    });

    it('does not follow a symlink planted as the home config', () => {
        const result = run({
            selfSudoRc: 1,
            setId: [],
            homeConfig: CONFIG,
            homeConfigIsLink: true,
        });
        expect(result.rootOnlyConfig).toBeNull();
        expect(result.homeConfigLeft).toBe(true);
    });

    it('leaves a home config.json that is not a proxy config alone', () => {
        const result = run({
            selfSudoRc: 1,
            setId: [],
            homeConfig: '{"compilerOptions":{}}',
        });
        expect(result.homeConfigLeft).toBe(true);
        expect(result.rootOnlyConfig).toBeNull();
    });

    it('refuses to confirm while the review user can read a proxy config', () => {
        const result = run({
            selfSudoRc: 1,
            setId: [],
            homeConfig: CONFIG,
            readable: ['<root-only>/proxy.json'],
        });
        expect(result.status).toBe(5);
        expect(result.stderr).toContain('review user can read');
        expect(result.stdout).not.toContain(PRIVILEGES_DROPPED_MARKER);
    });
});

describe('confirmsPrivilegesDropped', () => {
    it('needs both a zero exit and the marker', () => {
        expect(
            confirmsPrivilegesDropped({
                exitCode: 0,
                stdout: `${PRIVILEGES_DROPPED_MARKER}\n`,
            }),
        ).toBe(true);
        expect(confirmsPrivilegesDropped({ exitCode: 0, stdout: '' })).toBe(
            false,
        );
        expect(
            confirmsPrivilegesDropped({
                exitCode: 5,
                stdout: PRIVILEGES_DROPPED_MARKER,
            }),
        ).toBe(false);
    });
});
