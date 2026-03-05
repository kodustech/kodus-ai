import { BoundedMap } from '@libs/agents/skills/runtime/bounded-map';

describe('BoundedMap', () => {
    it('stores and retrieves values like a regular Map', () => {
        const map = new BoundedMap<string, number>(10);
        map.set('a', 1);
        map.set('b', 2);
        expect(map.get('a')).toBe(1);
        expect(map.get('b')).toBe(2);
        expect(map.size).toBe(2);
    });

    it('evicts the oldest entry when maxSize is reached', () => {
        const map = new BoundedMap<string, number>(3);
        map.set('a', 1);
        map.set('b', 2);
        map.set('c', 3);
        expect(map.size).toBe(3);

        map.set('d', 4);
        expect(map.size).toBe(3);
        expect(map.has('a')).toBe(false);
        expect(map.get('b')).toBe(2);
        expect(map.get('d')).toBe(4);
    });

    it('does not evict when updating an existing key', () => {
        const map = new BoundedMap<string, number>(3);
        map.set('a', 1);
        map.set('b', 2);
        map.set('c', 3);

        map.set('a', 10);
        expect(map.size).toBe(3);
        expect(map.get('a')).toBe(10);
        expect(map.has('b')).toBe(true);
        expect(map.has('c')).toBe(true);
    });

    it('preserves FIFO order when updating an existing key', () => {
        const map = new BoundedMap<string, number>(3);
        map.set('a', 1);
        map.set('b', 2);
        map.set('c', 3);

        map.set('a', 10);
        map.set('d', 4);

        expect(map.has('a')).toBe(false);
        expect(map.has('b')).toBe(true);
        expect(map.has('c')).toBe(true);
        expect(map.has('d')).toBe(true);
    });

    it('supports delete and clear', () => {
        const map = new BoundedMap<string, number>(10);
        map.set('a', 1);
        map.set('b', 2);

        expect(map.delete('a')).toBe(true);
        expect(map.has('a')).toBe(false);
        expect(map.size).toBe(1);

        map.clear();
        expect(map.size).toBe(0);
    });

    it('enforces minimum maxSize of 1', () => {
        const map = new BoundedMap<string, number>(0);
        map.set('a', 1);
        map.set('b', 2);
        expect(map.size).toBe(1);
        expect(map.has('b')).toBe(true);
    });
});
