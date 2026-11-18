import { z } from 'zod';

import { EXPOSE_KINDS, type ExposeKind } from '@libs/runtime/contracts/enums';
import { BrowserProbeSchema, HttpProbeSchema, SqlProbeSchema, type BrowserProbe, type HttpProbe, type Probe, type SqlProbe } from '@libs/runtime/probe/probe.schema';
import { parseRecipe, type Recipe } from '@libs/runtime/protocol/recipe';
import { redactPatterns } from '@libs/runtime/redaction/redaction';

import type { ProbeVerdict } from './run-state';
import { ObservedSchema, type Observed } from './run-report';

// Recorded reproduction inputs are inert data. The public manifest never
// exports recipe commands or generates a program for the developer's host.
// Isolated replay remains a separate capability; JSON does not promise it.

/** At most this many findings keep their probe on a Run. */
export const MAX_REPRODUCIBLE = 10;

/** The probe of one finding, as the observer sent it, with secrets redacted. */
export interface ReproducibleProbe {
    probeId: string;
    entryPoint: string;
    purpose: string;
    expected: string;
    spec: HttpProbe | SqlProbe | BrowserProbe;
    /** What the target was, from the environment's expose list. */
    targetKind?: ExposeKind;
    base?: Observed;
    pr?: Observed;
}

/** How the Run's recipe boots the app, read from its text. */
export interface ReproductionBoot {
    recipePath: string;
    composeFiles: string[];
    profiles: string[];
    migrate?: string;
    seed?: Recipe['seed'];
    /** The recipe's ready check: the health path on the public service's http port. */
    health?: { service: string; port: number; path: string; timeoutSeconds: number };
}

/** What a Run keeps to reproduce its findings (projection field `reproduction`). */
export interface RunReproduction {
    /** Absent when the Run booted without a recipe the parser accepts: there is no recorded boot metadata. */
    boot?: ReproductionBoot;
    probes: ReproducibleProbe[];
}

const redact = (text: string) => redactPatterns(text).text;

function redactSpec(spec: HttpProbe | SqlProbe | BrowserProbe): HttpProbe | SqlProbe | BrowserProbe {
    switch (spec.kind) {
        case 'http':
            return {
                ...spec,
                path: redact(spec.path),
                ...(spec.headers ? { headers: Object.fromEntries(Object.entries(spec.headers).map(([k, v]) => [k, redact(v)])) } : {}),
                ...(spec.body !== undefined ? { body: redact(spec.body) } : {}),
            };
        case 'sql':
            return { ...spec, query: redact(spec.query) };
        case 'browser':
            return {
                ...spec,
                steps: spec.steps.map((s) => ('fill' in s ? { fill: [s.fill[0], redact(s.fill[1])] as [string, string] } : s)),
            };
    }
}

/**
 * The reproduction of a Run: each finding's observer probe (shell probes never
 * decide a finding and never leave the VM) and the recipe's boot commands.
 */
export function reproductionFor(args: {
    findings: ProbeVerdict[];
    probes: Probe[];
    observed: (finding: ProbeVerdict) => { base?: Observed; pr?: Observed };
    expose: { service: string; port: number; kind: ExposeKind }[];
    recipe?: { path: string; content?: string | null };
}): RunReproduction | undefined {
    const byId = new Map(args.probes.map((p) => [p.id, p]));
    const probes: ReproducibleProbe[] = [];
    for (const f of args.findings) {
        if (f.verdict !== 'finding' || probes.length >= MAX_REPRODUCIBLE) continue;
        const p = byId.get(f.probeId);
        if (!p || p.spec.kind === 'shell') continue;
        const spec = p.spec;
        const target = spec.kind === 'browser' ? undefined : args.expose.find((e) => e.service === spec.target.service && e.port === spec.target.port);
        probes.push({
            probeId: p.id,
            entryPoint: f.entryPoint,
            purpose: redact(p.purpose),
            expected: redact(p.expected),
            spec: redactSpec(spec),
            ...(target ? { targetKind: target.kind } : {}),
            ...args.observed(f),
        });
    }
    if (!probes.length) return undefined;
    let boot: ReproductionBoot | undefined;
    if (args.recipe?.content) {
        const parsed = parseRecipe(args.recipe.content);
        if ('recipe' in parsed) {
            const r = parsed.recipe;
            const http = r.expose.find((e) => e.service === r.public[0] && e.kind === 'http');
            boot = {
                recipePath: args.recipe.path,
                composeFiles: r.composeFiles,
                profiles: r.profiles,
                ...(r.migrate ? { migrate: r.migrate } : {}),
                ...(r.seed ? { seed: r.seed } : {}),
                ...(r.health && http
                    ? { health: { service: http.service, port: http.port, path: r.health, timeoutSeconds: r.healthTimeoutSeconds ?? 120 } }
                    : {}),
            };
        }
    }
    return { ...(boot ? { boot } : {}), probes };
}

/** Public data only: no boot commands, executable script or execution authority. */
export const ReproductionManifestSchema = z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal('kodus.runtime.reproduction'),
    run: z.strictObject({
        runId: z.string().min(1).max(128),
        repositoryName: z.string().min(1).max(512),
        prNumber: z.number().int().positive(),
        baseSha: z.string().regex(/^[0-9a-f]{40}$/),
        headSha: z.string().regex(/^[0-9a-f]{40}$/),
        imageId: z.string().min(1).max(512).optional(),
    }),
    probe: z.strictObject({
        probeId: z.string().min(1).max(128),
        entryPoint: z.string().min(1).max(512),
        purpose: z.string().min(1).max(512),
        expected: z.string().min(1).max(2_048),
        spec: z.union([HttpProbeSchema, SqlProbeSchema, BrowserProbeSchema]),
        targetKind: z.enum(EXPOSE_KINDS).optional(),
        base: ObservedSchema.optional(),
        pr: ObservedSchema.optional(),
    }),
});
export type ReproductionManifest = z.infer<typeof ReproductionManifestSchema>;
export interface ReproductionDownload { filename: string; manifest: ReproductionManifest }
const MAX_MANIFEST_BYTES = 1_048_576;

/** Re-redact historical snapshots; parsing first bounds the shape and recursion. */
function redactData<T>(value: T): T {
    if (typeof value === 'string') return redact(value) as T;
    if (Array.isArray(value)) return value.map(redactData) as T;
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, redactData(field)])) as T;
    }
    return value;
}

/** Legacy projections remain readable, but only explicitly selected data can leave the API. */
export function reproductionManifest(args: {
    runId: string;
    repositoryName: string;
    prNumber: number;
    baseSha: string;
    headSha: string;
    imageId?: string;
    reproduction: RunReproduction;
    probeId: string;
}): ReproductionDownload | undefined {
    if (!Array.isArray(args.reproduction?.probes)) return undefined;
    const p = args.reproduction.probes.find((x) => x?.probeId === args.probeId);
    if (!p) return undefined;
    // An alias is not a recorded concrete pin. Older Runs may have none; never invent it.
    const candidate = args.imageId?.trim();
    const imageId = candidate && candidate !== 'latest' && candidate === args.imageId ? candidate : undefined;
    const parsed = ReproductionManifestSchema.safeParse({
        schemaVersion: 1,
        kind: 'kodus.runtime.reproduction',
        run: { runId: args.runId, repositoryName: args.repositoryName, prNumber: args.prNumber, baseSha: args.baseSha, headSha: args.headSha, ...(imageId ? { imageId } : {}) },
        probe: {
            probeId: p.probeId, entryPoint: p.entryPoint, purpose: p.purpose, expected: p.expected, spec: p.spec,
            ...(p.targetKind ? { targetKind: p.targetKind } : {}),
            ...(p.base ? { base: p.base } : {}), ...(p.pr ? { pr: p.pr } : {}),
        },
    });
    if (!parsed.success) return undefined;
    const manifest = redactData(parsed.data);
    // An identity that needs redaction cannot be exported or silently renamed:
    // it would leak through the filename or break Run/probe correlation.
    if (manifest.probe.probeId !== parsed.data.probe.probeId || JSON.stringify(manifest.run) !== JSON.stringify(parsed.data.run)) return undefined;
    // Redaction must not create an invalid probe. It is never repaired into executable content.
    if (!ReproductionManifestSchema.safeParse(manifest).success) return undefined;
    const filename = `kody-repro-pr${args.prNumber}-${manifest.probe.probeId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64)}.json`;
    const response = { filename, manifest };
    const serialized = JSON.stringify(response);
    // Keys and filenames are not rewritten: refuse the entire artifact if any
    // recognizable secret remains, rather than changing request semantics.
    if (Buffer.byteLength(serialized, 'utf8') > MAX_MANIFEST_BYTES || redact(serialized) !== serialized) return undefined;
    return response;
}
