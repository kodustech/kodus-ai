/**
 * A Map with a maximum size that evicts the oldest entries when full (FIFO).
 *
 * Drop-in replacement for `Map<K, V>` in caches that must not grow unbounded
 * in long-running processes (e.g., capability strategy, instruction cache).
 */
export class BoundedMap<K, V> {
    private readonly store = new Map<K, V>();
    private readonly maxSize: number;

    constructor(maxSize = 256) {
        this.maxSize = Math.max(1, maxSize);
    }

    get(key: K): V | undefined {
        return this.store.get(key);
    }

    has(key: K): boolean {
        return this.store.has(key);
    }

    set(key: K, value: V): this {
        if (!this.store.has(key) && this.store.size >= this.maxSize) {
            const oldest = this.store.keys().next().value;
            if (oldest !== undefined) {
                this.store.delete(oldest);
            }
        }

        this.store.set(key, value);
        return this;
    }

    delete(key: K): boolean {
        return this.store.delete(key);
    }

    clear(): void {
        this.store.clear();
    }

    get size(): number {
        return this.store.size;
    }

    keys(): IterableIterator<K> {
        return this.store.keys();
    }

    values(): IterableIterator<V> {
        return this.store.values();
    }

    entries(): IterableIterator<[K, V]> {
        return this.store.entries();
    }

    forEach(
        callbackfn: (value: V, key: K, map: BoundedMap<K, V>) => void,
    ): void {
        this.store.forEach((value, key) => callbackfn(value, key, this));
    }
}
