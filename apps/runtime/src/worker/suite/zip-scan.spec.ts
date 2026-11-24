import { deflateRawSync } from 'node:zlib';

import type { Canary } from '../canary/canary';
import { scanZip, ZIP_SCAN_LIMITS } from './zip-scan';

// A minimal hand-written zip container: stored (0) or deflated (8) entries, a central directory and the end record.
export function buildZip(entries: Array<{ name: string; data: Buffer; method?: number; flags?: number; declaredSize?: number }>): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
        const method = e.method ?? 8;
        const body = method === 8 ? deflateRawSync(e.data) : e.data;
        const name = Buffer.from(e.name);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(e.flags ?? 0, 6);
        lh.writeUInt16LE(method, 8);
        lh.writeUInt32LE(body.length, 18);
        lh.writeUInt32LE(e.declaredSize ?? e.data.length, 22);
        lh.writeUInt16LE(name.length, 26);
        const local = Buffer.concat([lh, name, body]);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0);
        ch.writeUInt16LE(20, 4);
        ch.writeUInt16LE(20, 6);
        ch.writeUInt16LE(e.flags ?? 0, 8);
        ch.writeUInt16LE(method, 10);
        ch.writeUInt32LE(body.length, 20);
        ch.writeUInt32LE(e.declaredSize ?? e.data.length, 24);
        ch.writeUInt16LE(name.length, 28);
        ch.writeUInt32LE(offset, 42);
        centrals.push(Buffer.concat([ch, name]));
        locals.push(local);
        offset += local.length;
    }
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
}

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
