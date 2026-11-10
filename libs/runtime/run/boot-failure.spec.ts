import { BOOT_FAILURE_LINE_MAX, BOOT_FAILURE_TAIL_LINES, bootFailureOf, bootOutputOf, clipMiddle } from './boot-failure';

const AT = '2026-11-06T12:00:00.000Z';
const GO_LINE = '#14 2.31 go: verifying module: github.com/a/b@v1.2.3: Get "https://sum.golang.org/lookup/github.com/a/b@v1.2.3": dial tcp: lookup sum.golang.org: no such host';
const buildkit = (...tail: string[]) =>
    ['compose up: exit 1', '#14 [api 5/9] RUN go work sync', GO_LINE, '#14 ERROR: process "/bin/sh -c go work sync" did not complete successfully: exit code: 1', ...tail].join('\n');
const none = (s: string) => s;

describe('bootFailureOf', () => {
    it('names the cause from the catalog and shows the line it read it from, not the last ERROR line', () => {
        const f = bootFailureOf({ side: 'pr', blocker: { kind: 'unknown', signature: 'compose_up', message: buildkit() }, at: AT, clean: none });
        expect(f).toMatchObject({ side: 'pr', kind: 'platform', signature: 'platform:go_checksum_db', at: AT, errorLine: GO_LINE });
        expect(f.title).toContain('github.com/a/b@v1.2.3');
        expect(f.logTail.at(-1)).toContain('#14 ERROR: process');
    });

    it('falls back to the last line that reads as an error when no rule knows the output', () => {
        const message = ['compose up: exit 1', 'error: something odd', 'step 3', 'Error: the last one', 'done'].join('\n');
        const f = bootFailureOf({ side: 'base', blocker: { kind: 'unknown', signature: 'compose_up', message }, at: AT, clean: none });
        expect(f.errorLine).toBe('Error: the last one');
        expect(f.kind).toBe('unknown');
    });

    it('has no error line when nothing reads as one', () => {
        expect(bootOutputOf({ message: 'one\ntwo' }, none)).toEqual({ logTail: ['one', 'two'] });
    });

    it('keeps the last 40 lines, each cut in the middle at 300 characters, without terminal escapes', () => {
        const lines = Array.from({ length: 100 }, (_, i) => `\x1b[31mline ${i}\x1b[0m ${'y'.repeat(i === 99 ? 1_000 : 0)}`);
        const out = bootOutputOf({ message: lines.join('\n') }, none);
        expect(out.logTail).toHaveLength(BOOT_FAILURE_TAIL_LINES);
        expect(out.logTail[0]).toBe('line 60');
        expect(out.logTail.at(-1)!.length).toBe(BOOT_FAILURE_LINE_MAX);
        expect(out.logTail.at(-1)).toMatch(/^line 99 y+…y+$/);
        expect(out.logTail.join('\n')).not.toContain('\x1b');
    });

    it('cleans the whole reason before it splits or cuts it, and the title and signature too', () => {
        const secret = 'kdx_live_0123456789abcdef0123456789abcdef';
        const clean = (s: string) => s.split(secret).join('[redacted]');
        const f = bootFailureOf({
            side: 'pr',
            blocker: { kind: 'unknown', signature: `compose_up`, message: `error: bad key ${secret}\n${'z'.repeat(400)} ${secret}` },
            at: AT,
            clean,
        });
        expect(JSON.stringify(f)).not.toContain(secret);
        expect(f.errorLine).toBe('error: bad key [redacted]');
    });

    it('reads a setup claim\'s boot output from its bundle', () => {
        const out = bootOutputOf(
            {
                message: 'compose up: exit 1',
                bundle: {
                    services: [{ name: 'boot output', state: 'failed', logTail: ['a', GO_LINE, 'b'] }],
                    ports: [],
                    disk: [],
                    deniedEgress: [],
                    redactions: 0,
                    truncated: false,
                    collectedAt: AT,
                },
            },
            none,
        );
        expect(out).toEqual({ errorLine: GO_LINE, logTail: ['a', GO_LINE, 'b'] });
    });
});

describe('clipMiddle', () => {
    it('keeps the head and the tail', () => {
        expect(clipMiddle('abcdefghij', 5)).toBe('ab…ij');
        expect(clipMiddle('abc', 5)).toBe('abc');
    });
});
