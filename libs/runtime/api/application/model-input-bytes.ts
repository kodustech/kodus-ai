/** Conservative JSON UTF-8 size before allocation; raw SDK optional undefined fields are omitted. */
export function modelInputBytes(value: unknown, maxBytes = 2_000_000): number {
    let bytes = 1024,
        nodes = 0; // Fixed protocol/chat framing allowance.
    const active = new Set<object>();
    const add = (n: number) => {
        bytes += n;
        if (bytes > maxBytes) throw Error('model input too large');
    };
    const text = (s: string) => {
        add(2 + Buffer.byteLength(s, 'utf8'));
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if (
                c >= 0xd800 &&
                c <= 0xdbff &&
                i + 1 < s.length &&
                s.charCodeAt(i + 1) >= 0xdc00 &&
                s.charCodeAt(i + 1) <= 0xdfff
            ) {
                i++;
                continue;
            }
            if (c >= 0xd800 && c <= 0xdfff) add(3);
            else if (c < 32) add(5);
            else if (c === 34 || c === 92) add(1);
        }
    };
    const visit = (v: unknown, depth: number) => {
        if (++nodes > 20_000 || depth > 32)
            throw Error('model input structure too large');
        if (v === null) return add(4);
        if (typeof v === 'string') return text(v);
        if (typeof v === 'boolean') return add(5);
        if (typeof v === 'number' && Number.isFinite(v)) return add(32);
        if (!v || typeof v !== 'object' || active.has(v))
            throw Error('invalid model input');
        const array = Array.isArray(v),
            proto = Object.getPrototypeOf(v);
        if (
            proto !== (array ? Array.prototype : Object.prototype) &&
            !(proto === null && !array)
        )
            throw Error('invalid model input');
        if (Object.getOwnPropertySymbols(v).length)
            throw Error('invalid model input');
        const keys = Object.getOwnPropertyNames(v).filter(
            (k) => !(array && k === 'length'),
        );
        if (
            array &&
            keys.length !== Object.getOwnPropertyDescriptor(v, 'length')!.value
        )
            throw Error('invalid model input');
        active.add(v);
        add(2);
        for (const k of keys) {
            const d = Object.getOwnPropertyDescriptor(v, k)!;
            if (!d.enumerable || !('value' in d) || k === '__proto__')
                throw Error('invalid model input');
            if (d.value === undefined && !array) continue;
            text(k);
            add(2);
            visit(d.value, depth + 1);
        }
        active.delete(v);
    };
    visit(value, 0);
    return bytes;
}
