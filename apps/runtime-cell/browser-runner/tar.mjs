// A minimal ustar writer: the runner hands its artifacts to the cell as one
// tar stream on stdout, so nothing is written to a host path. Regular files
// only, flat names, no links: the cell reads the stream with archive/tar and
// keeps only the names it expects (internal/browser).

const BLOCK = 512;

function octal(value, width) {
    // width - 1 digits and a NUL, as ustar wants.
    return value.toString(8).padStart(width - 1, '0') + '\0';
}

/** The header block of one regular file. */
export function tarHeader(name, size, mtimeSec = 0) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new Error(`tar: bad name ${name}`);
    const h = Buffer.alloc(BLOCK, 0);
    h.write(name, 0, 100, 'ascii');
    h.write(octal(0o644, 8), 100, 8, 'ascii');
    h.write(octal(0, 8), 108, 8, 'ascii');
    h.write(octal(0, 8), 116, 8, 'ascii');
    h.write(octal(size, 12), 124, 12, 'ascii');
    h.write(octal(mtimeSec, 12), 136, 12, 'ascii');
    h.write('        ', 148, 8, 'ascii'); // checksum counted as spaces
    h.write('0', 156, 1, 'ascii');
    h.write('ustar\0', 257, 6, 'ascii');
    h.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    return h;
}

/** One file as tar blocks: header, data, zero padding to the block. */
export function tarEntry(name, data) {
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    return [tarHeader(name, data.length), data, Buffer.alloc(pad, 0)];
}

/** The end of the archive: two zero blocks. */
export const TAR_END = Buffer.alloc(BLOCK * 2, 0);
