import { deflateRawSync } from 'node:zlib';

/** A minimal hand-written zip container for tests: stored (0) or deflated (8) entries, a central directory and the end record. */
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
