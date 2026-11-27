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
 * entry is the length of that string. Eviction drops the oldest insertions
 * first (a read or a re-set moves the key to the end). An entry larger than
 * `maxEntryChars` is not stored at all: it would evict many useful entries to
 * cache one value that is unlikely to repeat.
 *
 * The character budget evicts only large values. The same cache holds small
 * flags that must last their TTL, such as the once-a-day "review skipped (no
 * license)" notice dedupe: evicted with the file contents, the author got the
 * notice again every few hours. Small entries leave by the entry cap, and by
 * size only once no large value is left; with the global bounds that never
 * happens (50k × 1,024 is 51M of 256M characters), but `maxChars` holds
 * either way. Large keys keep their own order, so the size budget never walks
 * past the small ones.
 */

/** Values below this size are evicted only by the entry cap, not by size. */
export const SMALL_ENTRY_CHARS = 1_024;
export interface BoundedMemoryStoreOptions {
    maxEntries: number;
    /** Total characters held across all values (UTF-16: ~2 bytes each). */
    maxChars: number;
    maxEntryChars: number;
}

export class BoundedMemoryStore<V = unknown> extends Map<string, V> {
    private chars = 0;
    /** Keys of values of at least SMALL_ENTRY_CHARS, least recently used first. */
    private readonly large = new Set<string>();

    constructor(private readonly opts: BoundedMemoryStoreOptions) {
        super();
    }

    /** The bounds this store enforces. */
    get bounds(): Readonly<BoundedMemoryStoreOptions> {
        return this.opts;
    }

    /** Characters currently held, for metrics and tests. */
    get heldChars(): number {
        return this.chars;
    }

    override set(key: string, value: V): this {
        const size = sizeOf(value);
        this.delete(key);
        if (size > this.opts.maxEntryChars) return this;
        super.set(key, value);
        this.chars += size;
        if (size >= SMALL_ENTRY_CHARS) this.large.add(key);
        // The size budget takes large values first.
        for (const oldest of this.large) {
            if (this.chars <= this.opts.maxChars) break;
            if (oldest === key) continue;
            this.delete(oldest);
        }
        // The entry cap, and the size budget if small values alone pass it.
        for (const oldest of this.keys()) {
            if (
                this.size <= this.opts.maxEntries &&
                this.chars <= this.opts.maxChars
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
        this.chars -= sizeOf(super.get(key) as V);
        this.large.delete(key);
        return super.delete(key);
    }

    override clear(): void {
        super.clear();
        this.large.clear();
        this.chars = 0;
    }
}

function sizeOf(value: unknown): number {
    if (typeof value === 'string') return value.length;
    // Keyv hands strings; anything else is counted small but never free.
    return 64;
}
