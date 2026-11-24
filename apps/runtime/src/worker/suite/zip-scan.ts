import { inflateRawSync } from 'node:zlib';

import { redactPatterns } from '@libs/runtime/redaction';

import { type Canary, containsCanary } from '../canary/canary';

// A zip artifact (a Playwright trace.zip) embeds the network requests, their headers and bodies, and the console text of the test:
// a secret the test sent would be stored and served as is. This reads the archive's entries within bounds and looks in each one
// that can hold text for a canary or a secret pattern, before the zip is stored. Only the zip container is parsed here (central
// directory, stored and deflate entries); anything else is "unreadable" and the caller never stores what it could not scan.

export const ZIP_SCAN_LIMITS = {
    /** Entries in the archive: a trace has a few hundred. */
    entries: 2000,
    /** One entry's bytes once inflated: bounds memory for a single inflate, whatever the header declares. */
    entryBytes: 16 * 1024 * 1024,
    /** All entries' bytes once inflated: a bomb is many small-looking entries as well as one big one. */
    totalBytes: 64 * 1024 * 1024,
} as const;

export type ZipScan = { verdict: 'clean' } | { verdict: 'canary' } | { verdict: 'secret' } | { verdict: 'unreadable'; why: string };

/** Entries that are images, video or fonts by name: not scanned (documented: images and video are never read for secrets). */
const BINARY_NAME = /\.(png|jpe?g|gif|webp|bmp|ico|webm|mp4|woff2?|ttf|otf)$/i;
const ARCHIVE_NAME = /\.(zip|gz|tgz|zst|bz2|xz|7z|jar)$/i;

const unreadable = (why: string): ZipScan => ({ verdict: 'unreadable', why });

interface Entry {
    name: string;
    method: number;
    compressedSize: number;
    size: number;
    offset: number;
}

function readEntries(zip: Buffer): Entry[] | string {
    const min = Math.max(0, zip.length - 22 - 0xffff);
    let eocd = -1;
    for (let i = zip.length - 22; i >= min; i--) {
        if (zip.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) return 'no end of central directory';
    const count = zip.readUInt16LE(eocd + 10);
    const cdSize = zip.readUInt32LE(eocd + 12);
    const cdOffset = zip.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return 'zip64 is not supported';
    if (count > ZIP_SCAN_LIMITS.entries) return 'too many entries';
    if (cdOffset + cdSize > eocd) return 'central directory out of bounds';
    const out: Entry[] = [];
    let p = cdOffset;
    for (let n = 0; n < count; n++) {
        if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) return 'bad central directory entry';
        const flags = zip.readUInt16LE(p + 8);
        const method = zip.readUInt16LE(p + 10);
        const compressedSize = zip.readUInt32LE(p + 20);
        const size = zip.readUInt32LE(p + 24);
        const nameLen = zip.readUInt16LE(p + 28);
        const extraLen = zip.readUInt16LE(p + 30);
        const commentLen = zip.readUInt16LE(p + 32);
        const offset = zip.readUInt32LE(p + 42);
        if (p + 46 + nameLen > zip.length) return 'bad central directory entry';
        const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
        if (flags & 0x1 || flags & 0x40) return 'encrypted entry';
        if (method !== 0 && method !== 8) return `unsupported compression method ${method}`;
        if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) return 'zip64 is not supported';
        out.push({ name, method, compressedSize, size, offset });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
}

function entryBytes(zip: Buffer, e: Entry): Buffer | string {
    const p = e.offset;
    if (p + 30 > zip.length || zip.readUInt32LE(p) !== 0x04034b50) return 'bad local header';
    const start = p + 30 + zip.readUInt16LE(p + 26) + zip.readUInt16LE(p + 28);
    const end = start + e.compressedSize;
    if (end > zip.length) return 'entry out of bounds';
    const raw = zip.subarray(start, end);
    if (e.method === 0) return raw.length > ZIP_SCAN_LIMITS.entryBytes ? 'entry too large' : raw;
    try {
        // maxOutputLength is what stops a bomb whatever the headers declare: it throws once the output would pass it.
        return inflateRawSync(raw, { maxOutputLength: ZIP_SCAN_LIMITS.entryBytes });
    } catch {
        return 'entry does not inflate within the limit';
    }
}

const decodeUtf8 = (b: Buffer): string | undefined => {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(b);
    } catch {
        return undefined;
    }
};

/** Never throws. `clean` means every entry that can hold text was read and held neither a canary nor a secret pattern. */
export function scanZip(zip: Buffer, canaries: readonly Canary[]): ZipScan {
    try {
        const entries = readEntries(zip);
        if (typeof entries === 'string') return unreadable(entries);
        let declared = 0;
        for (const e of entries) {
            if (ARCHIVE_NAME.test(e.name)) return unreadable('nested archive');
            if (e.size > ZIP_SCAN_LIMITS.entryBytes) return unreadable('entry too large');
            declared += e.size;
            if (declared > ZIP_SCAN_LIMITS.totalBytes) return unreadable('archive too large when inflated');
        }
        let inflated = 0;
        let secret = false;
        for (const e of entries) {
            if (e.name.endsWith('/') || BINARY_NAME.test(e.name)) continue;
            const body = entryBytes(zip, e);
            if (typeof body === 'string') return unreadable(body);
            inflated += body.length;
            if (inflated > ZIP_SCAN_LIMITS.totalBytes) return unreadable('archive too large when inflated');
            const utf8 = decodeUtf8(body);
            // Not text: a response body can still carry a canary in its ASCII bytes, so those are read as latin1 for canaries only.
            if (utf8 === undefined) {
                if (canaries.length > 0 && containsCanary(body.toString('latin1'), [...canaries])) return { verdict: 'canary' };
                continue;
            }
            if (canaries.length > 0 && containsCanary(utf8, [...canaries])) return { verdict: 'canary' };
            if (redactPatterns(utf8).count > 0) secret = true;
        }
        return secret ? { verdict: 'secret' } : { verdict: 'clean' };
    } catch {
        return unreadable('malformed archive');
    }
}
