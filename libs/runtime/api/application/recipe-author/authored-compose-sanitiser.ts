import { posix } from 'path';

import * as yaml from 'js-yaml';
import { UNTRUSTED_YAML } from '@libs/runtime/protocol/yaml-limits';

/**
 * What Kodus rewrites in a compose file Kody wrote under .kodus/, before the
 * authored-files checks read it: the compose features the cell refuses but
 * that have one meaning Kodus can write itself. Only Kody's own files, never
 * a file of the repository. Each change is said back to the model and on the
 * setup's recipe step, so a rewrite never passes unseen.
 *
 * - `container_name`: dropped (the cell names containers per claim; the
 *   cell's own adapter drops it too, but the checks refuse it first).
 * - `extends` of a service of the same file: inlined, the base first and the
 *   service's own keys over it. One that names another file stays, and the
 *   checks refuse it.
 * - `env_file` entries whose file is not at the commit: dropped (compose
 *   would fail on them). One that is there stays, and the checks refuse it.
 *
 * Paths in Kody's compose files are written from the repository root (the
 * cell reads them so: compose/project.go pathBase).
 */
export interface SanitisedCompose {
    content: string;
    /** What was changed, one line each, in words the model and the setup step can show. */
    changes: string[];
}

const isMap = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
/** YAML a compose file holds is plain data. */
const clone = <T>(v: T): T =>
    v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);

/** Lists compose merges by concatenation when a service extends another. */
const CONCATENATED = new Set([
    'ports',
    'expose',
    'volumes',
    'tmpfs',
    'cap_drop',
]);

/** environment as a map, from its map or its list form. */
function envMap(v: unknown): Record<string, unknown> | null {
    if (isMap(v)) return { ...v };
    if (Array.isArray(v)) {
        const out: Record<string, unknown> = {};
        for (const s of v) {
            const [k, rest] = String(s).split(/=(.*)/s);
            out[k] = rest === undefined ? null : rest;
        }
        return out;
    }
    return null;
}

/** The service `child` over its resolved base, as compose merges an extends. */
function merged(
    base: Record<string, unknown>,
    child: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = clone(base);
    for (const [k, v] of Object.entries(child)) {
        if (k === 'extends') continue;
        const was = out[k];
        if (k === 'environment') {
            const a = envMap(was);
            const b = envMap(v);
            out[k] = a && b ? { ...a, ...b } : v;
        } else if (isMap(was) && isMap(v)) out[k] = { ...was, ...v };
        else if (
            Array.isArray(was) &&
            Array.isArray(v) &&
            CONCATENATED.has(k)
        ) {
            const seen = new Set(was.map((x) => JSON.stringify(x)));
            out[k] = [...was, ...v.filter((x) => !seen.has(JSON.stringify(x)))];
        } else out[k] = clone(v);
    }
    return out;
}

/** The base service an extends names in this same file, or null (another file, or not a form Kodus reads). */
function sameFileBase(ext: unknown, path: string): string | null {
    if (typeof ext === 'string') return ext;
    if (!isMap(ext) || typeof ext.service !== 'string') return null;
    if (ext.file === undefined || ext.file === null) return ext.service;
    if (typeof ext.file !== 'string') return null;
    const file = ext.file.replace(/^\.\//, '');
    // From the repository root (how Kody writes paths), or from the file's own directory (how compose reads them).
    if (
        posix.normalize(file) === path ||
        posix.normalize(posix.join(posix.dirname(path), file)) === path
    )
        return ext.service;
    return null;
}

/** A path of the compose file from the repository root, or null when it is not a plain path inside it. */
function repoRelative(p: string): string | null {
    if (!p || p.startsWith('/') || /[$~\\]/.test(p) || p.includes('://'))
        return null;
    const n = posix.normalize(p);
    if (n === '.' || n === '..' || n.startsWith('../')) return null;
    return n;
}

/**
 * The compose file Kody wrote at `path`, with what Kodus rewrites, and what it
 * changed. A file that does not parse, or has no services mapping, comes back
 * as it was (the checks say what is wrong). The text is written again only
 * when something changed: comments and anchors go with that rewrite.
 */
export async function sanitiseAuthoredCompose(
    path: string,
    content: string,
    exists: (path: string) => Promise<boolean>,
): Promise<SanitisedCompose> {
    let doc: unknown;
    try {
        doc = yaml.load(content, UNTRUSTED_YAML);
    } catch {
        // Left as written: the compose check refuses YAML that does not parse.
        return { content, changes: [] };
    }
    if (!isMap(doc) || !isMap(doc.services)) return { content, changes: [] };
    const services = doc.services;
    const changes: string[] = [];

    // extends first: a base's container_name and env_file reach the service, and are handled below with its own.
    const resolved = new Map<string, Record<string, unknown> | null>();
    const resolve = (
        name: string,
        seen: Set<string>,
    ): Record<string, unknown> | null => {
        if (resolved.has(name)) return resolved.get(name)!;
        const svc = services[name];
        if (!isMap(svc)) return null;
        if (svc.extends === undefined) return svc;
        const base = sameFileBase(svc.extends, path);
        if (!base || seen.has(base) || !isMap(services[base])) {
            resolved.set(name, null);
            return null;
        }
        const from = resolve(base, new Set([...seen, name]));
        const out = from ? merged(from, svc) : null;
        resolved.set(name, out);
        return out;
    };
    for (const [name, svc] of Object.entries(services)) {
        if (!isMap(svc) || svc.extends === undefined) continue;
        const base = sameFileBase(svc.extends, path);
        const out = resolve(name, new Set([name]));
        if (!out || !base) continue;
        services[name] = out;
        changes.push(
            `${path} services.${name}.extends: inlined service ${base} of the same file (the cell reads no extends)`,
        );
    }

    for (const [name, svc] of Object.entries(services)) {
        if (!isMap(svc)) continue;
        if (svc.container_name !== undefined) {
            delete svc.container_name;
            changes.push(
                `${path} services.${name}.container_name: dropped (the cell names the containers of each claim)`,
            );
        }
        if (svc.env_file === undefined) continue;
        const entries = Array.isArray(svc.env_file)
            ? svc.env_file
            : [svc.env_file];
        const kept: unknown[] = [];
        for (const e of entries) {
            const file =
                typeof e === 'string'
                    ? e
                    : isMap(e) && typeof e.path === 'string'
                      ? e.path
                      : null;
            const rel = file === null ? null : repoRelative(file);
            if (rel !== null && !(await exists(rel))) {
                changes.push(
                    `${path} services.${name}.env_file: dropped ${rel}, which is not in the repository at this commit`,
                );
                continue;
            }
            kept.push(e);
        }
        if (kept.length === entries.length) continue;
        if (!kept.length) delete svc.env_file;
        else svc.env_file = Array.isArray(svc.env_file) ? kept : kept[0];
    }

    if (!changes.length) return { content, changes };
    return {
        content: yaml.dump(doc, { noRefs: true, lineWidth: -1 }),
        changes,
    };
}
