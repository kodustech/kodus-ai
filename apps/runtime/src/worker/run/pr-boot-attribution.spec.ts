import { infraBootBlocker } from './report';

// A PR side that does not boot while the base did is the PR's (pr_destabilizes_machine),
// unless what stopped it is a fault the cell or the hub declared about itself. The PR's
// own output (its build and service logs, the reason the cell quotes) never decides it:
// the PR writes those lines.

const OOM_LOG = 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory';
const bundleWith = (line: string): any => ({ services: [{ name: 'web', state: 'Exited (1)', logTail: ['starting server', line] }], ports: [], disk: [], deniedEgress: [], redactions: 0, truncated: false, collectedAt: '2026-11-17T00:00:00.000Z' });
const blocked = (kind: string, signature: string, message: string, extra: Record<string, unknown> = {}) => ({ blockers: [{ kind, signature, message, ...extra }] as any[] });

describe('infraBootBlocker: a PR boot failure is excused only by what the cell or the hub declared', () => {
    it.each([
        ['an OOM line in the service log', blocked('toolchain', 'compose_up', 'compose up: exit 1', { bundle: bundleWith(OOM_LOG) })],
        ['an OOM line in the reason', blocked('toolchain', 'compose_up', `compose up: exit 1\n${OOM_LOG}`)],
        ['exit code 137 in the reason', blocked('toolchain', 'compose_up', 'web exited with code 137')],
        ['a disk-full line', blocked('toolchain', 'compose_up', 'Error: write /tmp/x: no space left on device')],
        ['a refused database connection', blocked('toolchain', 'compose_up', 'Error: connect ECONNREFUSED 127.0.0.1:5432')],
        ['an unresolved host', blocked('toolchain', 'compose_up', 'getaddrinfo ENOTFOUND api.example.com')],
        ['a Go checksum lookup the sandbox does not reach', blocked('unknown', 'compose_up', '#14 2.31 go: verifying module: github.com/a/b@v1.2.3: Get "https://sum.golang.org/lookup/github.com/a/b@v1.2.3": dial tcp: lookup sum.golang.org: no such host')],
        ['a service that exited, with an OOM line', blocked('unknown', 'service_exited:web', 'the web service exited', { bundle: bundleWith(OOM_LOG) })],
        ['a ready check that never answered, with an OOM line', blocked('unknown', 'not_ready', 'not ready', { bundle: bundleWith(OOM_LOG) })],
        // Resources the PR's own code consumes: the base booted under the same machine size.
        ['the workload killed at its memory limit', blocked('resources', 'out_of_memory', 'killed at its memory limit')],
        ['the environment filling its own data disk', blocked('resources', 'disk_capacity', 'the environment filled its data disk')],
        ['the claim the disk watchdog stopped as the top writer', blocked('resources', 'disk_top_writer', 'this claim\'s disk grew the most')],
        ['an image past the cell bound', blocked('resources', 'image_too_large', 'the image is 40 GB')],
        ['a boot that outlived its wait with its build state in place', blocked('resources', 'boot_timeout', 'the boot did not finish in 30 min')],
    ])('is the PR\'s: %s', (_label, b) => {
        expect(infraBootBlocker(b)).toBe(false);
    });

    it.each([
        ['the cell lost during the boot', blocked('platform', 'cell_lost', 'the cell disconnected')],
        ['the cell unavailable', blocked('platform', 'cell_unavailable', 'no cell')],
        ['a Kodus step that failed', blocked('platform', 'claim_network', 'could not create the network')],
        ['the builder dying outside the build steps', blocked('platform', 'builder_failed', 'docker could not run the builder (exit 125)')],
        ['the cell disk watchdog', blocked('resources', 'cell_disk_full', 'the cell disk is under its floor')],
        ['no room on any cell', blocked('resources', 'no_capacity', 'every cell is full')],
        ['the machine size the cell cannot grant', blocked('resources', 'size_unavailable', 'above what this cell grants')],
    ])('is the cell\'s: %s', (_label, b) => {
        expect(infraBootBlocker(b)).toBe(true);
    });

    it('a cell signature still needs every blocker of the side to be the cell\'s', () => {
        expect(infraBootBlocker({ blockers: [...blocked('platform', 'cell_lost', 'x').blockers, ...blocked('toolchain', 'compose_up', OOM_LOG).blockers] })).toBe(false);
    });

    it('a boot that timed out building cold because the cell had evicted the build state is the cell\'s', () => {
        expect(infraBootBlocker({ ...blocked('resources', 'boot_timeout', 'the boot did not finish in 30 min'), buildStateEvictedAt: '2026-11-13T07:31:31.000Z' })).toBe(true);
    });

    it('no blocker excuses nothing', () => {
        expect(infraBootBlocker({ blockers: [] })).toBe(false);
    });
});
