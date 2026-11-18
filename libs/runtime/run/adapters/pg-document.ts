// A document kept as one Postgres row: typed columns for what the reads
// filter, sort and join on, and one jsonb column with the rest of the
// document (nested payloads the code reads whole). Column names come only
// from the spec, never from input.

export type ColumnKind = 'text' | 'integer' | 'timestamptz' | 'boolean';

/** [the document's field, its column, its type]. */
export type ColumnSpec = readonly [field: string, column: string, kind: ColumnKind];

export interface SplitPatch {
    /** Typed columns the patch sets, in order, and their values. */
    columns: string[];
    values: unknown[];
    /** The rest of the patch, for the jsonb column. */
    rest: Record<string, unknown>;
}

const isoOf = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    const t = Date.parse(String(v));
    if (!Number.isFinite(t)) throw new RangeError(`not a time: ${String(v)}`);
    return new Date(t).toISOString();
};

function toColumn(kind: ColumnKind, v: unknown): unknown {
    if (v === null || v === undefined) return null;
    switch (kind) {
        case 'timestamptz':
            return isoOf(v);
        case 'integer':
            return Number(v);
        case 'boolean':
            return !!v;
        default:
            return String(v);
    }
}

function fromColumn(kind: ColumnKind, v: unknown): unknown {
    switch (kind) {
        case 'timestamptz':
            return isoOf(v);
        case 'integer':
            return Number(v);
        case 'boolean':
            return !!v;
        default:
            return String(v);
    }
}

export class DocumentTable<T extends object> {
    private readonly byField: ReadonlyMap<string, { column: string; kind: ColumnKind }>;

    constructor(
        readonly specs: readonly ColumnSpec[],
        /** The jsonb column with every field the spec does not name. */
        readonly rest: string,
    ) {
        this.byField = new Map(specs.map(([field, column, kind]) => [field, { column, kind }]));
    }

    /** The columns a SELECT reads back into the document. */
    get selectList(): string {
        return [...this.specs.map(([, c]) => c), this.rest].join(', ');
    }

    column(field: string): string {
        const c = this.byField.get(field);
        if (!c) throw new Error(`no column for ${field}`);
        return c.column;
    }

    /**
     * The typed values and the rest of a patch. A field set to undefined is
     * written as null, as Mongo's $set wrote it, so it reads back as null in
     * the jsonb rest and as absent in a typed column.
     */
    split(patch: Record<string, unknown>): SplitPatch {
        const out: SplitPatch = { columns: [], values: [], rest: {} };
        for (const [field, value] of Object.entries(patch)) {
            const c = this.byField.get(field);
            if (c) {
                out.columns.push(c.column);
                out.values.push(toColumn(c.kind, value));
            } else {
                out.rest[field] = value === undefined ? null : value;
            }
        }
        return out;
    }

    /** The document a row holds: the jsonb rest, then each typed column that is not null. */
    read(row: Record<string, unknown>): T {
        const doc: Record<string, unknown> = { ...((row[this.rest] as Record<string, unknown> | null) ?? {}) };
        for (const [field, column, kind] of this.specs) {
            const v = row[column];
            if (v !== null && v !== undefined) doc[field] = fromColumn(kind, v);
        }
        return doc as T;
    }
}

/** A jsonb parameter: always text, so a top-level array is never sent as a Postgres array. */
export const jsonb = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
