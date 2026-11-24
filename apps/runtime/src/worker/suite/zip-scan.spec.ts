import { buildZip } from './zip-testing';

import type { Canary } from '../canary/canary';
import { scanZip, ZIP_SCAN_LIMITS } from './zip-scan';


const canary: Canary = { slot: 'npmrc', value: '//registry.example/:_authToken=kdcanary-9f8e7d6c5b4a3210', core: '9f8e7d6c5b4a3210' };
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const text = (s: string) => Buffer.from(s, 'utf8');

describe('scanning a zip artifact before it is stored', () => {
    it('is clean when no text entry holds a canary or a secret', () => {
        const zip = buildZip([{ name: 'trace.trace', data: text('{"type":"event"}\n') }, { name: 'resources/a.png', data: Buffer.from([0x89, 0x50, 0xff, 0xfe]) }]);
        expect(scanZip(zip, [canary])).toEqual({ verdict: 'clean' });
    });

    it('finds a canary in a network entry, deflated or stored', () => {
        for (const method of [8, 0]) {
            const zip = buildZip([{ name: 'trace.network', data: text(`{"headers":[{"name":"authorization","value":"${canary.value}"}]}`), method }]);
            expect(scanZip(zip, [canary])).toEqual({ verdict: 'canary' });
        }
    });

    it('finds a canary in an entry whose bytes are not valid UTF-8', () => {
        const zip = buildZip([{ name: 'resources/abc', data: Buffer.concat([Buffer.from([0xff, 0xfe]), text(canary.value)]) }]);
        expect(scanZip(zip, [canary])).toEqual({ verdict: 'canary' });
    });

    it('finds a secret pattern', () => {
        const zip = buildZip([{ name: '0-trace.network', data: text(`{"body":"aws_access_key_id = ${AWS_KEY}"}`) }]);
        expect(scanZip(zip, [])).toEqual({ verdict: 'secret' });
    });

    it('refuses a zip bomb, by what the entry really inflates to', () => {
        const zip = buildZip([{ name: 'trace.trace', data: Buffer.alloc(ZIP_SCAN_LIMITS.entryBytes + 1, 0x61), declaredSize: 10 }]);
        expect(scanZip(zip, [])).toMatchObject({ verdict: 'unreadable' });
    });

    it('refuses a total over the limit, an entry that declares too much, and too many entries', () => {
        const big = Buffer.alloc(ZIP_SCAN_LIMITS.entryBytes, 0x61);
        const many = Array.from({ length: Math.ceil(ZIP_SCAN_LIMITS.totalBytes / ZIP_SCAN_LIMITS.entryBytes) + 1 }, (_, i) => ({ name: `e${i}.txt`, data: big }));
        expect(scanZip(buildZip(many), [])).toMatchObject({ verdict: 'unreadable' });
        expect(scanZip(buildZip([{ name: 'a.png', data: text('x'), declaredSize: 0xfffffff0 }]), [])).toMatchObject({ verdict: 'unreadable' });
        const files = Array.from({ length: ZIP_SCAN_LIMITS.entries + 1 }, (_, i) => ({ name: `f${i}.txt`, data: text('x') }));
        expect(scanZip(buildZip(files), [])).toMatchObject({ verdict: 'unreadable' });
    });

    it('refuses encrypted entries, other methods, nested archives, and bytes that are no zip', () => {
        expect(scanZip(buildZip([{ name: 'a.txt', data: text('x'), flags: 1 }]), [])).toMatchObject({ verdict: 'unreadable' });
        expect(scanZip(buildZip([{ name: 'a.txt', data: text('x'), method: 12 }]), [])).toMatchObject({ verdict: 'unreadable' });
        expect(scanZip(buildZip([{ name: 'inner.zip', data: text('x') }]), [])).toMatchObject({ verdict: 'unreadable' });
        expect(scanZip(Buffer.from('not a zip at all'), [])).toMatchObject({ verdict: 'unreadable' });
    });
});
