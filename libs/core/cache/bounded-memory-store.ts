/**
 * In-memory store for the global cache, bounded in entries AND in size.
 *
 * Why it exists: `CacheModule.register({ store: 'memory', max })` is a
 * cache-manager v4 API. With @nestjs/cache-manager 3 + cache-manager 7 both
 * options are ignored; the cache is a bare `new Keyv()` over a plain `Map`,
 * and Keyv only drops an expired entry when that same key is read again. The
 * GitHub client caches file contents and PR file lists under keys that carry a
 * blob or head sha, so almost no key is ever read again and every entry stayed
 * for the life of the process: review workers grew ~100 MB/h until the 8 GB
 * heap limit (Nov 2026).
 *
 * Keyv serializes every value to a string before `set`, so the size of an
 * entry is the heap that string takes (`sizeOf`). Eviction drops the oldest insertions
 * first (a read or a re-set moves the key to the end). An entry larger than
 * `maxEntryBytes` is not stored at all: it would evict many useful entries to
 * cache one value that is unlikely to repeat.
 *
 * The character budget evicts only large values. The same cache holds small
 * flags that must last their TTL, such as the once-a-day "review skipped (no
 * license)" notice dedupe: evicted with the file contents, the author got the
 * notice again every few hours. Small entries leave by the entry cap, and by
 * size only once no large value is left; with the global bounds that never
 * happens on a production worker (200k × 1 KB is 205 MB of 2 GB),
 * but `maxBytes` holds either way. Large keys keep their own order, so the size budget never walks
 * past the small ones.
 */

/** Values below this size are evicted only by the entry cap, not by size. */
export const SMALL_ENTRY_BYTES = 1_024;
export interface BoundedMemoryStoreOptions {
    maxEntries: number;
    /** Total bytes V8 holds for all values (see `sizeOf`). */
    maxBytes: number;
    maxEntryBytes: number;
}

export class BoundedMemoryStore<V = unknown> extends Map<string, V> {
    private bytes = 0;
    /** Size of each held value, so a delete does not rescan it. */
    private readonly sizes = new Map<string, number>();
    /** Keys of values of at least SMALL_ENTRY_BYTES, least recently used first. */
    private readonly large = new Set<string>();

    constructor(private readonly opts: BoundedMemoryStoreOptions) {
        super();
    }

    /** The bounds this store enforces. */
    get bounds(): Readonly<BoundedMemoryStoreOptions> {
        return this.opts;
    }

    /** Bytes currently held, for metrics and tests. */
    get heldBytes(): number {
        return this.bytes;
    }

    override set(key: string, value: V): this {
        const size = sizeOf(value);
        this.delete(key);
        if (size > this.opts.maxEntryBytes) return this;
        super.set(key, value);
        this.sizes.set(key, size);
        this.bytes += size;
        if (size >= SMALL_ENTRY_BYTES) this.large.add(key);
        // The size budget takes large values first.
        for (const oldest of this.large) {
            if (this.bytes <= this.opts.maxBytes) break;
            if (oldest === key) continue;
            this.delete(oldest);
        }
        // The entry cap, and the size budget if small values alone pass it.
        for (const oldest of this.keys()) {
            if (
                this.size <= this.opts.maxEntries &&
                this.bytes <= this.opts.maxBytes
            )
                break;
            if (oldest === key) continue;
            this.delete(oldest);
        }
        return this;
    }

    /**
     * A read moves the key to the newest end, so eviction takes the entries
     * nobody reads first. The same cache holds state that is read on every
     * event (rate limiters, the BYOK error counter) next to file contents read
     * once; insertion order alone would evict a live counter before them.
     */
    override get(key: string): V | undefined {
        const value = super.get(key);
        if (value !== undefined) {
            super.delete(key);
            super.set(key, value);
            if (this.large.delete(key)) this.large.add(key);
        }
        return value;
    }

    override delete(key: string): boolean {
        if (!super.has(key)) return false;
        this.bytes -= this.sizes.get(key) ?? 0;
        this.sizes.delete(key);
        this.large.delete(key);
        return super.delete(key);
    }

    override clear(): void {
        super.clear();
        this.large.clear();
        this.sizes.clear();
        this.bytes = 0;
    }
}

/** A character outside Latin-1: its string is stored two bytes per char. */
const TWO_BYTE_CHAR = /[\u0100-\uffff]/;

/**
 * The heap V8 spends on a value. A string whose characters all fit in Latin-1
 * is stored one byte per character, and one character outside it makes the
 * whole string two bytes per character (measured on Node 22: 1.00 and 2.00
 * bytes per char of `JSON.stringify` output). Keyv hands JSON, so file
 * contents are almost always one byte per character; counting characters
 * would leave the real heap between one and two times the budget.
 */
export function sizeOf(value: unknown): number {
    if (typeof value === 'string') {
        return value.length * (TWO_BYTE_CHAR.test(value) ? 2 : 1);
    }
    // Keyv hands strings; anything else is counted small but never free.
    return 64;
}
