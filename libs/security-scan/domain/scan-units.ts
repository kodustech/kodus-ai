import { createHash } from 'crypto';

import type { SurfaceHit, SurfaceMap, VulnClass } from './surface/surface.types';
import type { ScanUnit } from './security-scan.types';
import { VULN_CLASSES } from './scan-prompts';

const EXTENSION_LANGUAGE: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'typescript',
    jsx: 'typescript',
    mjs: 'typescript',
    cjs: 'typescript',
    py: 'python',
    go: 'go',
    java: 'java',
    kt: 'kotlin',
    kts: 'kotlin',
    rs: 'rust',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    scala: 'scala',
    cs: 'csharp',
    swift: 'swift',
    dart: 'dart',
    ex: 'elixir',
    exs: 'elixir',
    rb: 'ruby',
    php: 'php',
    c: 'c',
    h: 'c',
    sh: 'bash',
    bash: 'bash',
};

export function languageOf(file: string): string {
    const ext = file.split('.').pop()?.toLowerCase() ?? '';
    return EXTENSION_LANGUAGE[ext] ?? 'unknown';
}

export function unitId(file: string): string {
    return createHash('sha1').update(file).digest('hex').slice(0, 16);
}

export interface MapCandidate {
    file: string;
    entryPoints: number;
    authChecks: number;
    sinks: number;
    classes: VulnClass[];
    sample: string[];
    score: number;
}

/**
 * Files worth auditing, most promising first: a file where outside input
 * enters AND a dangerous operation sits scores highest; a sink alone next;
 * an entry point alone (a candidate for a missing authorization check) last.
 */
export function rankCandidates(
    surface: SurfaceMap,
    /** The plan's own limit; no default cut, so no file falls out unseen. */
    limit = Number.POSITIVE_INFINITY,
): MapCandidate[] {
    const hitsByFile = new Map<string, SurfaceHit[]>();
    for (const hit of surface.hits) {
        const list = hitsByFile.get(hit.file) ?? [];
        list.push(hit);
        hitsByFile.set(hit.file, list);
    }

    const candidates = Object.entries(surface.files).map(([file, f]) => {
        const classes = new Set<VulnClass>(f.classes);
        // Where outside input enters, a missing check (authz), input reaching
        // a sink the pattern scan did not know (injection) and an unsafe
        // web setting (misconfiguration) are the likeliest bugs, whatever
        // sinks the patterns saw.
        if (f.entryPoints > 0) {
            classes.add('authz');
            classes.add('injection');
            // A route served to a browser is where CSRF and cookie flags live.
            classes.add('misconfiguration');
            // Work an outside caller can make the server do without bound.
            classes.add('resource_exhaustion');
        }
        const score =
            (f.entryPoints > 0 && f.sinks > 0 ? 50 : 0) +
            Math.min(f.sinks, 10) * 4 +
            Math.min(f.entryPoints, 10) * 2 -
            (f.authChecks > 0 && f.sinks === 0 ? 5 : 0);
        const sample = (hitsByFile.get(file) ?? [])
            .filter((h) => h.role !== 'auth_check')
            .slice(0, 3)
            .map(
                (h) =>
                    `${h.line}: [${h.role}${h.vulnClass ? `/${h.vulnClass}` : ''}] ${h.text.trim().slice(0, 100)}`,
            );
        return {
            file,
            entryPoints: f.entryPoints,
            authChecks: f.authChecks,
            sinks: f.sinks,
            classes: VULN_CLASSES.filter((c) => classes.has(c)),
            sample,
            score,
        };
    });

    return candidates
        .filter((c) => c.classes.length > 0)
        .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
        .slice(0, limit);
}

/** The plan without the model: one unit per candidate, in rank order. */
export function heuristicUnits(
    candidates: MapCandidate[],
    maxUnits: number,
): ScanUnit[] {
    return candidates.slice(0, maxUnits).map((c, i) => ({
        id: unitId(c.file),
        file: c.file,
        relatedFiles: [],
        language: languageOf(c.file),
        classes: c.classes,
        priority: Math.max(0, 100 - i),
        reasons: [
            `pattern scan: ${c.entryPoints} entry point(s), ${c.sinks} dangerous operation(s), ${c.authChecks} auth check(s)`,
        ],
    }));
}

export interface MapPlanUnit {
    file: string;
    relatedFiles?: string[];
    classes?: string[];
    priority?: number;
    reason?: string;
}

/**
 * The model's plan, held to the repository: paths that are not in it are
 * dropped (a model can invent one), classes are limited to the five, and the
 * heuristic's own candidates fill whatever room the plan left.
 */
export function mergeMapPlan(params: {
    plan: MapPlanUnit[];
    candidates: MapCandidate[];
    existingFiles: Set<string>;
    maxUnits: number;
}): ScanUnit[] {
    const units: ScanUnit[] = [];
    const seen = new Set<string>();
    const candidateByFile = new Map(params.candidates.map((c) => [c.file, c]));

    const normalize = (p: string) => p.trim().replace(/^\.?\//, '');

    for (const item of params.plan) {
        const file = normalize(item.file);
        if (!file || seen.has(file) || !params.existingFiles.has(file)) {
            continue;
        }
        // The model adds classes; it never drops what the pattern scan saw.
        // VULN_CLASSES keeps the order.
        const wanted = new Set<string>([
            ...(item.classes ?? []),
            ...(candidateByFile.get(file)?.classes ?? []),
        ]);
        const finalClasses = VULN_CLASSES.filter((c) => wanted.has(c));
        if (!finalClasses.length) {
            continue;
        }
        seen.add(file);
        units.push({
            id: unitId(file),
            file,
            relatedFiles: (item.relatedFiles ?? [])
                .map(normalize)
                .filter((f) => f !== file && params.existingFiles.has(f))
                .slice(0, 5),
            language: languageOf(file),
            classes: finalClasses,
            priority: clampPriority(item.priority),
            reasons: [
                ...(candidateByFile.has(file)
                    ? []
                    : ['added by the planner: the pattern scan missed it']),
                ...(item.reason ? [item.reason] : []),
            ],
        });
        if (units.length >= params.maxUnits) {
            break;
        }
    }

    units.sort(
        (a, b) => b.priority - a.priority || a.file.localeCompare(b.file),
    );
    // The heuristic fills the room the plan left, after it and in its own
    // risk order: units run in this order, and sorting these in would tie
    // them all at one priority and run them by file name.
    for (const unit of heuristicUnits(
        params.candidates.filter((c) => !seen.has(c.file)),
        params.maxUnits - units.length,
    )) {
        units.push({ ...unit, priority: Math.min(unit.priority, 10) });
    }
    return units;
}

function clampPriority(value: number | undefined): number {
    return Math.max(0, Math.min(100, Math.round(value ?? 50)));
}

/**
 * The plan with every open finding's file read again for its class: a fix
 * that removed the dangerous operation leaves the pattern scan nothing to
 * draw it back, and a file no lens reads for a class never resolves that
 * class's findings. A file no longer in the repository is left out (the
 * scan resolves its findings as gone). Added after the plan, so they never
 * push a new candidate out of it.
 *
 * `finished`: units of a carried-on plan already done. They stay done, and
 * the classes they lack go to a unit of their own, so only those run.
 */
export function withRevisits(
    units: ScanUnit[],
    revisit: Array<{ filePath: string; vulnerabilityClass: string }>,
    existingFiles: ReadonlySet<string>,
    finished: ReadonlySet<string> = new Set(),
): ScanUnit[] {
    const wanted = new Map<string, Set<string>>();
    for (const { filePath, vulnerabilityClass } of revisit) {
        const file = filePath.trim().replace(/^\.?\//, '');
        if (!existingFiles.has(file)) continue;
        wanted.set(
            file,
            (wanted.get(file) ?? new Set()).add(vulnerabilityClass),
        );
    }
    const lacking = (have: ReadonlySet<string>, want: Set<string>) =>
        VULN_CLASSES.filter((c) => want.has(c) && !have.has(c));
    // Every class each file's units read, finished or not.
    const coveredByFile = new Map<string, Set<string>>();
    for (const unit of units) {
        const covered = coveredByFile.get(unit.file) ?? new Set<string>();
        unit.classes.forEach((c) => covered.add(c));
        coveredByFile.set(unit.file, covered);
    }
    const merged: ScanUnit[] = [];
    for (const unit of units) {
        const want = wanted.get(unit.file);
        const missing = want ? lacking(new Set(unit.classes), want) : [];
        if (!missing.length || finished.has(unit.id)) {
            merged.push(unit);
            continue;
        }
        // An unfinished unit takes the classes it lacks: they run with it.
        wanted.delete(unit.file);
        const all = new Set<string>([...unit.classes, ...missing]);
        merged.push({
            ...unit,
            classes: VULN_CLASSES.filter((c) => all.has(c)),
        });
    }
    const ids = new Set(merged.map((u) => u.id));
    for (const [file, want] of wanted) {
        const covered = coveredByFile.get(file);
        const classes = lacking(covered ?? new Set(), want);
        if (!classes.length) continue;
        // Named by its classes: a plan carried on twice can already hold an
        // earlier revisit of the file, for other classes.
        const id = covered
            ? unitId(`${file}#revisit:${classes.join(',')}`)
            : unitId(file);
        if (ids.has(id)) continue;
        ids.add(id);
        merged.push({
            id,
            file,
            relatedFiles: [],
            language: languageOf(file),
            classes,
            priority: 0,
            reasons: [
                'an open finding is here: read again to see if it was fixed',
            ],
        });
    }
    return merged;
}
