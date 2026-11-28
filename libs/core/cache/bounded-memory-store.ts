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
 * The byte budget evicts only large values. The same cache holds small
 * flags that must last their TTL, such as the once-a-day "review skipped (no
 * license)" notice dedupe: evicted with the file contents, the author got the
 * notice again every few hours. So, past either bound, the store first drops
 * the entries whose TTL has passed (Keyv passes the TTL to `set`; it would
 * only drop them on a read that never comes), then large values, oldest
 * first, and small ones only once no large value is left. With the global
 * bounds the entry cap (200k) comes long before small values alone could
 * fill the byte budget, but `maxBytes` holds either way. Large keys keep
 * their own order, so neither bound walks past the small ones.
 */

/** Values below this size are evicted only by the entry cap, not by size. */
export const SMALL_ENTRY_BYTES = 1_024;
/** Expired entries are swept at most this often (a sweep reads every entry
 *  set with a TTL: about 3 ms for 200k on a worker). */
export const SWEEP_INTERVAL_MS = 1_000;
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
    /** When each entry set with a TTL expires (ms since epoch). */
    private readonly expiresAt = new Map<string, number>();
    /** No entry expires before this, so no sweep is needed until then. */
    private nextExpiry = Infinity;
    /** When the last sweep ran: a full cache with keys expiring every few
     *  ms would otherwise rescan every entry on every write. */
    private lastSweep = -Infinity;

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

    /**
     * `ttl` is what Keyv passes as the third argument (ms). Keyv drops an
     * expired entry only when its key is read again, so the store keeps the
     * expiry itself: an entry nobody reads again must not hold a place a
     * live one needs.
     */
    override set(key: string, value: V, ttl?: number): this {
        const size = sizeOf(value);
        this.delete(key);
        if (size > this.opts.maxEntryBytes) return this;
        super.set(key, value);
        this.sizes.set(key, size);
        this.bytes += size;
        if (size >= SMALL_ENTRY_BYTES) this.large.add(key);
        if (typeof ttl === 'number' && ttl > 0) {
            const at = Date.now() + ttl;
            this.expiresAt.set(key, at);
            if (at < this.nextExpiry) this.nextExpiry = at;
        }
        if (this.overBounds()) this.dropExpired();
        // The size budget takes large values first.
        for (const oldest of this.large) {
            if (this.bytes <= this.opts.maxBytes) break;
            if (oldest === key) continue;
            this.delete(oldest);
        }
        // The entry cap takes large values first too: they are file contents
        // a reader can fetch again, the small ones are flags and counters.
        for (const oldest of this.large) {
            if (this.size <= this.opts.maxEntries) break;
            if (oldest === key) continue;
            this.delete(oldest);
        }
        // Then any entry, when small values alone pass a bound.
        for (const oldest of this.keys()) {
            if (!this.overBounds()) break;
            if (oldest === key) continue;
            this.delete(oldest);
        }
        return this;
    }

    private overBounds(): boolean {
        return (
            this.size > this.opts.maxEntries || this.bytes > this.opts.maxBytes
        );
    }

    /**
     * Drops every entry whose TTL has passed, if any can have. Expired means
     * what Keyv means: `now > expires`, so an entry is still served at its
     * expiry millisecond.
     */
    private dropExpired(): void {
        const now = Date.now();
        if (now <= this.nextExpiry) return;
        if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
        this.lastSweep = now;
        let next = Infinity;
        for (const [key, at] of this.expiresAt) {
            if (at < now) this.delete(key);
            else if (at < next) next = at;
        }
        this.nextExpiry = next;
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
        this.expiresAt.delete(key);
        return super.delete(key);
    }

    override clear(): void {
        super.clear();
        this.large.clear();
        this.sizes.clear();
        this.expiresAt.clear();
        this.nextExpiry = Infinity;
        this.lastSweep = -Infinity;
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
