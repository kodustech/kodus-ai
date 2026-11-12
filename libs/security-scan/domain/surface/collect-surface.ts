import { LANGUAGE_SURFACES } from './languages';
import {
    GrepFn,
    LanguageSurface,
    SurfaceHit,
    SurfaceMap,
    SurfacePattern,
    SurfaceRole,
    VulnClass,
} from './surface.types';

export const MAX_HITS_PER_PATTERN = 2000;
const MAX_TEXT_CHARS = 300;
/** Lines longer than this are generated/minified; only their head is re-tested. */
const MAX_RETEST_CHARS = 5000;
/** Above this a role's combined regex is split, so one rg call stays a sane command line. */
const MAX_COMBINED_REGEX_CHARS = 12000;
const NO_MATCHES = 'No matches found.';
const ROLES: SurfaceRole[] = ['entry_point', 'auth_check', 'sink'];
const VULN_CLASS_ORDER: VulnClass[] = [
    'authz',
    'injection',
    'ssrf',
    'data_exposure',
    'secret_identity',
    'misconfiguration',
    'resource_exhaustion',
];

export interface RgLine {
    file: string;
    line: number;
    text: string;
}

function normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
}

function parseRgLines(stdout: string): RgLine[] {
    const trimmed = stdout.trim();
    if (!trimmed || trimmed === NO_MATCHES || trimmed.startsWith('Error:')) {
        return [];
    }
    const lines: RgLine[] = [];
    for (const raw of stdout.split('\n')) {
        // Lazy `.*?` splits on the FIRST `:<digits>:`, so a colon inside the
        // matched text never moves the boundary.
        const m = /^(.+?):(\d+):(.*)$/.exec(raw.replace(/\r$/, ''));
        if (!m) continue;
        lines.push({
            file: normalizePath(m[1]),
            line: Number(m[2]),
            text: m[3],
        });
    }
    return lines;
}

/** Parses `rg --no-heading -n` output into `{file, line, text}` (text trimmed, ≤300 chars). */
export function parseRgOutput(stdout: string): RgLine[] {
    return parseRgLines(stdout).map((l) => ({
        ...l,
        text: l.text.trim().slice(0, MAX_TEXT_CHARS),
    }));
}

const SKIP_DIR =
    /(?:^|\/)(?:test|tests|__tests__|__test__|spec|specs|__mocks__|fixtures?|__fixtures__|testdata|test_data|vendor|third_party|node_modules|bower_components|dist|build|coverage|\.next|_build|deps|Pods|DerivedData|\.dart_tool)\//;
const SKIP_FILE =
    /(?:\.(?:spec|test|e2e-spec|stories)\.\w+|_test\.(?:go|py|rb|exs?|dart|c|cc|cpp)|_spec\.rb|\.min\.\w+|\.d\.ts|\.pb\.go|_pb2\.py|\.generated\.\w+|(?:^|\/)test_[^/]*\.py|(?:^|\/)conftest\.py|[a-z0-9](?:Tests?|Spec|IT)\.(?:java|kt|scala|cs|swift))$/;

/** Tests, fixtures, vendored deps and build output are not the app's attack surface.
 *  `target/` is not here: the listing is tracked files, where a Maven or Cargo
 *  build never is, and an app may live under it. */
export function isSkippedPath(path: string): boolean {
    const p = normalizePath(path);
    return SKIP_DIR.test(p) || SKIP_FILE.test(p);
}

function escapeRegExp(s: string): string {
    return s.replace(/[.+^$(){}|[\]\\]/g, '\\$&');
}

function globBody(glob: string): string {
    let out = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                if (glob[i + 2] === '/') {
                    out += '(?:.*/)?';
                    i += 2;
                } else {
                    out += '.*';
                    i += 1;
                }
            } else {
                out += '[^/]*';
            }
        } else if (c === '?') {
            out += '[^/]';
        } else if (c === '{' && glob.indexOf('}', i) !== -1) {
            const close = glob.indexOf('}', i);
            const alts = glob
                .slice(i + 1, close)
                .split(',')
                .map(globBody);
            out += `(?:${alts.join('|')})`;
            i = close;
        } else {
            out += escapeRegExp(c);
        }
    }
    return out;
}

/** Minimal gitignore-flavoured glob: `**`, `*`, `?`, `{a,b}`; no `/` means a basename match. */
export function globToRegExp(glob: string): RegExp {
    const g = normalizePath(glob).replace(/^\//, '');
    const body = globBody(g);
    return new RegExp(g.includes('/') ? `^${body}$` : `^(?:.*/)?${body}$`);
}

export function matchesGlob(path: string, glob: string): boolean {
    return globToRegExp(glob).test(normalizePath(path));
}

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
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    hh: 'cpp',
    hxx: 'cpp',
    scala: 'scala',
    sc: 'scala',
    cs: 'csharp',
    swift: 'swift',
    dart: 'dart',
    ex: 'elixir',
    exs: 'elixir',
    rb: 'ruby',
    rake: 'ruby',
    php: 'php',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    ksh: 'bash',
};

const MARKER_LANGUAGE: Record<string, string> = {
    'tsconfig.json': 'typescript',
    'package.json': 'typescript',
    'requirements.txt': 'python',
    'pyproject.toml': 'python',
    'Pipfile': 'python',
    'go.mod': 'go',
    'pom.xml': 'java',
    'build.gradle': 'java',
    'build.gradle.kts': 'kotlin',
    'Cargo.toml': 'rust',
    'CMakeLists.txt': 'cpp',
    'build.sbt': 'scala',
    'Package.swift': 'swift',
    'pubspec.yaml': 'dart',
    'mix.exs': 'elixir',
    'Gemfile': 'ruby',
    'Rakefile': 'ruby',
    'composer.json': 'php',
};

/** Language keys present in a repo listing, in LANGUAGE_SURFACES order. */
export function detectLanguages(listing: string[]): string[] {
    const found = new Set<string>();
    for (const raw of listing) {
        const path = normalizePath(raw.trim());
        if (!path || isSkippedPath(path)) continue;
        const base = path.slice(path.lastIndexOf('/') + 1);
        const marker = MARKER_LANGUAGE[base];
        if (marker) found.add(marker);
        if (base.endsWith('.csproj') || base.endsWith('.sln')) {
            found.add('csharp');
        }
        const dot = base.lastIndexOf('.');
        if (dot > 0) {
            const lang = EXTENSION_LANGUAGE[base.slice(dot + 1).toLowerCase()];
            if (lang) found.add(lang);
        }
    }
    return LANGUAGE_SURFACES.map((s) => s.language).filter((l) => found.has(l));
}

export function combineRegex(patterns: SurfacePattern[]): string {
    return patterns.map((p) => `(?:${p.regex})`).join('|');
}

interface GrepBatch {
    language: string;
    glob: string;
    patterns: SurfacePattern[];
}

/** One batch per (glob, role); a role whose combined regex is too long is split. */
export function planBatches(surface: LanguageSurface): GrepBatch[] {
    const groups = [
        { glob: surface.glob, patterns: surface.patterns },
        ...(surface.extraGlobs ?? []),
    ];
    const batches: GrepBatch[] = [];
    for (const group of groups) {
        for (const role of ROLES) {
            let current: SurfacePattern[] = [];
            let size = 0;
            for (const p of group.patterns.filter((x) => x.role === role)) {
                const len = p.regex.length + 5;
                if (current.length && size + len > MAX_COMBINED_REGEX_CHARS) {
                    batches.push({
                        language: surface.language,
                        glob: group.glob,
                        patterns: current,
                    });
                    current = [];
                    size = 0;
                }
                current.push(p);
                size += len;
            }
            if (current.length) {
                batches.push({
                    language: surface.language,
                    glob: group.glob,
                    patterns: current,
                });
            }
        }
    }
    return batches;
}

const compiled = new Map<string, RegExp>();
function jsRegex(pattern: SurfacePattern): RegExp {
    let re = compiled.get(pattern.regex);
    if (!re) {
        re = new RegExp(pattern.regex);
        compiled.set(pattern.regex, re);
    }
    return re;
}

export interface CollectSurfaceOptions {
    languages: string[];
    root?: string;
    excludeGlobs?: string[];
    /** Concurrent grep calls (each one is a sandbox round-trip). */
    concurrency?: number;
    /** Overridable for tests. */
    surfaces?: LanguageSurface[];
}

async function runPool<T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
): Promise<void> {
    let next = 0;
    const lanes = Array.from(
        { length: Math.max(1, Math.min(concurrency, items.length)) },
        async () => {
            while (next < items.length) {
                const item = items[next++];
                await worker(item);
            }
        },
    );
    await Promise.all(lanes);
}

/**
 * Maps entry points, auth checks and sinks with a handful of rg calls per
 * language. Each rg hit is attributed back to the pattern(s) it came from by
 * re-testing the line in JS. A failing grep is recorded, never thrown.
 */
export async function collectSurface(
    grep: GrepFn,
    opts: CollectSurfaceOptions,
): Promise<SurfaceMap> {
    const root = opts.root ?? '.';
    const surfaces = (opts.surfaces ?? LANGUAGE_SURFACES).filter((s) =>
        opts.languages.includes(s.language),
    );
    const excludes = (opts.excludeGlobs ?? []).map(globToRegExp);
    const batches = surfaces.flatMap(planBatches);

    const errors: SurfaceMap['errors'] = [];
    const perBatchHits: SurfaceHit[][] = batches.map(() => []);

    await runPool(
        batches.map((b, i) => ({ b, i })),
        opts.concurrency ?? 4,
        async ({ b, i }) => {
            const regex = combineRegex(b.patterns);
            let stdout: string;
            try {
                stdout = await grep(regex, root, b.glob);
            } catch (err) {
                errors.push({
                    language: b.language,
                    patternIds: b.patterns.map((p) => p.id),
                    message: `grep failed: ${err instanceof Error ? err.message : String(err)}`,
                });
                return;
            }
            if (stdout.trim().startsWith('Error:')) {
                errors.push({
                    language: b.language,
                    patternIds: b.patterns.map((p) => p.id),
                    message: stdout.trim().slice(0, 500),
                });
                return;
            }
            for (const l of parseRgLines(stdout)) {
                if (isSkippedPath(l.file)) continue;
                if (excludes.some((re) => re.test(l.file))) continue;
                const probe = l.text.slice(0, MAX_RETEST_CHARS);
                for (const p of b.patterns) {
                    if (!jsRegex(p).test(probe)) continue;
                    perBatchHits[i].push({
                        file: l.file,
                        line: l.line,
                        text: l.text.trim().slice(0, MAX_TEXT_CHARS),
                        patternId: p.id,
                        role: p.role,
                        language: b.language,
                        ...(p.vulnClass ? { vulnClass: p.vulnClass } : {}),
                        ...(p.cwe ? { cwe: p.cwe } : {}),
                        ...(p.framework ? { framework: p.framework } : {}),
                    });
                }
            }
        },
    );

    // Deterministic order regardless of pool scheduling, then cap + dedupe.
    const hits: SurfaceHit[] = [];
    const seen = new Set<string>();
    const perPattern = new Map<string, number>();
    const truncated = new Map<string, { language: string; dropped: number }>();
    // Every distinct hit, the capped ones too: the cap bounds the leads the
    // lenses read, never which files are candidates.
    const allHits: SurfaceHit[] = [];
    for (const h of perBatchHits.flat()) {
        const key = `${h.file}\u0000${h.line}\u0000${h.patternId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        allHits.push(h);
        const n = perPattern.get(h.patternId) ?? 0;
        if (n >= MAX_HITS_PER_PATTERN) {
            const t = truncated.get(h.patternId) ?? {
                language: h.language,
                dropped: 0,
            };
            t.dropped++;
            truncated.set(h.patternId, t);
            continue;
        }
        perPattern.set(h.patternId, n + 1);
        hits.push(h);
    }
    for (const [patternId, t] of truncated) {
        errors.push({
            language: t.language,
            patternIds: [patternId],
            message: `truncated: kept ${MAX_HITS_PER_PATTERN} hits, dropped ${t.dropped}`,
        });
    }

    const files: SurfaceMap['files'] = {};
    for (const h of allHits) {
        const f = (files[h.file] ??= {
            entryPoints: 0,
            authChecks: 0,
            sinks: 0,
            classes: [],
        });
        if (h.role === 'entry_point') f.entryPoints++;
        else if (h.role === 'auth_check') f.authChecks++;
        else {
            f.sinks++;
            if (h.vulnClass && !f.classes.includes(h.vulnClass)) {
                f.classes.push(h.vulnClass);
            }
        }
    }
    const classRank = new Map(VULN_CLASS_ORDER.map((c, i) => [c, i]));
    for (const f of Object.values(files)) {
        f.classes.sort(
            (a, b) => (classRank.get(a) ?? 0) - (classRank.get(b) ?? 0),
        );
    }

    return {
        languages: surfaces.map((s) => s.language),
        hits,
        files,
        errors,
    };
}
