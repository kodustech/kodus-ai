import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
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
 * - `chmod ug-s <f>` removes <f> from that list.
 */
const run = (opts: {
    selfSudoRc: number;
    setId: string[];
    chmodWorks?: boolean;
}) => {
    const dir = mkdtempSync(join(tmpdir(), 'kdrop-'));
    const log = join(dir, 'calls.log');
    const setIdFile = join(dir, 'setid');
    writeFileSync(log, '');
    writeFileSync(setIdFile, opts.setId.map((f) => `${f}\n`).join(''));
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
            'if [ "${1:-}" = "-u" ]; then shift 2; [ "${1:-}" = "--" ] && shift; "$@"; exit $?; fi',
            'exit "$SELF_SUDO_RC"',
        ].join('\n'),
    );
    stub('id', 'echo 1000');
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
        const script = buildDropReviewUserPrivilegesScript();
        expect(script).toContain(ROOT_SAFE_PATH_LINE);
        const result = spawnSync(
            'bash',
            ['-c', script.split(ROOT_SAFE_PATH_LINE).join(':')],
            {
                env: {
                    PATH: `${dir}:/usr/bin:/bin`,
                    SELF_SUDO_RC: String(opts.selfSudoRc),
                    CHMOD_WORKS: opts.chmodWorks === false ? '0' : '1',
                } as unknown as NodeJS.ProcessEnv,
                encoding: 'utf8',
            },
        );
        return {
            ...result,
            calls: readFileSync(log, 'utf8').split('\n').filter(Boolean),
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
