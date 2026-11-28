import type { FailureBundle } from '@libs/runtime/protocol';

import { classifyBlocker } from '../catalog';

// The bundle's lines are the PR's build output: a repository can print any
// text there. The classifier runs on the API's request path, so on the
// largest bundle the protocol accepts (500 lines of 2,048 characters) it
// stays fast whatever the lines say.

const LINE = 2048;
const LINES = 500;
const fill = (prefix: string, unit: string) => (prefix + unit.repeat(LINE)).slice(0, LINE);

const HOSTILE: Record<string, string> = {
    'an installer line with one long URL': fill('npm ERR! http://', 'a'),
    'an installer line with one long URL and spaces after it': fill('npm ERR! http://' + 'a'.repeat(240), ' x'),
    'an installer line of many URLs': fill('npm ERR! ', 'http://a.b '),
    'an installer line of many URLs glued together': fill('npm ERR! ', 'http://a.b/'),
    'an auth failure code then no URL': fill('npm ERR! E401 ', 'x'),
    'many auth failure codes then no URL': fill('npm ERR! ', 'E401 '),
    'a .npmrc-like line with no token': fill('//', 'a'),
    'a .npmrc-like line whose token names no variable': fill('', '//a/').slice(0, LINE - 20) + ':_authToken=${}',
    'a name lookup with no end': fill("Temporary failure resolving '", 'a'),
    'a long lowercase run': fill('', 'a/'),
    'a long module path before the go.sum message': ('a'.repeat(LINE) + " is not pinned by this claim's go.sum").slice(-LINE),
    'a checksum lookup with no module': fill('verifying ', 'a').slice(0, LINE - 20) + ' sum.golang.org',
};

const bundle = (logTail: string[]): FailureBundle => ({
    services: [{ name: 'kodus-boot', state: 'exited', logTail }],
    ports: [],
    disk: [],
    deniedEgress: [],
    redactions: 0,
    truncated: false,
    collectedAt: '2026-11-13T12:00:00.000Z',
});

/** The fastest of three classifications of a full bundle of `line`: the least a loaded machine adds noise to. */
const fastestMs = (line: string) => {
    const input = { kind: 'toolchain', signature: 'compose_up', message: 'compose up: exit 1', bundle: bundle(Array.from({ length: LINES }, () => line)) };
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
        const started = process.hrtime.bigint();
        classifyBlocker(input);
        best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
    }
    return best;
};

describe('the classifier on hostile build output', () => {
    // A ratio against plain build output of the same size, measured in the same test, never a wall-clock bound:
    // linear rules cost a few times a plain bundle; the backtracking they replaced cost hundreds of times (the go.sum
    // pattern took about 450 ms a bundle where the plain one takes about 10 ms, v-core N4).
    const plain = fill('#12 [web 4/9] RUN pnpm install --frozen-lockfile ', 'downloading packages ');
    it.each(Object.entries(HOSTILE))('%s: a full bundle of it costs about what plain output of the same size does', (_name, line) => {
        const baseline = Math.max(fastestMs(plain), 1);
        expect(fastestMs(line) / baseline).toBeLessThan(20);
    });

    it('reads the module and version of the go.sum message as before, also after a long run of module characters', () => {
        const line = (m: string) => classifyBlocker({ kind: 'toolchain', signature: 'compose_up', message: 'compose up: exit 1', bundle: bundle([m]) }).signature;
        expect(line("go: example.com/new@v1.2.3 is not pinned by this claim's go.sum")).toBe('toolchain:go_module_not_pinned:example.com/new');
        expect(line(`${'-'.repeat(50)}${'a'.repeat(300)}@v1.0.0 is not pinned by this claim's go.sum`)).toBe(`toolchain:go_module_not_pinned:${'a'.repeat(201)}`);
        expect(line("go: example.com/new@ is not pinned by this claim's go.sum")).not.toContain('go_module_not_pinned');
    });

    it('still reads the registry host of a 401 printed after the URL', () => {
        const c = classifyBlocker({
            kind: 'toolchain',
            signature: 'compose_up',
            message: 'compose up: exit 1',
            bundle: bundle(['npm ERR! GET https://npm.corp.example/@corp%2fui/-/ui-1.0.0.tgz - 401 Unauthorized']),
        });
        expect(c.signature).toBe('external_service:credential:npm.corp.example');
    });
});
