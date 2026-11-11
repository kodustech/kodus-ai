export type VulnClass =
    | 'authz'
    | 'injection'
    | 'ssrf'
    | 'data_exposure'
    | 'secret_identity'
    | 'misconfiguration'
    | 'resource_exhaustion';

export type SurfaceRole = 'entry_point' | 'auth_check' | 'sink';

export interface SurfacePattern {
    /** Stable id, e.g. 'ts.express.route'. */
    id: string;
    role: SurfaceRole;
    /**
     * Ripgrep (Rust regex) syntax that is ALSO a valid JS RegExp: no
     * lookaround, no backreferences, no inline flags, braces always escaped.
     */
    regex: string;
    /** Required when role === 'sink'. */
    vulnClass?: VulnClass;
    /** e.g. 'CWE-89', for sinks. */
    cwe?: string;
    /** e.g. 'express', 'django'. */
    framework?: string;
}

export interface LanguageSurface {
    /** e.g. 'typescript' (the TS+JS family key), 'python', ... */
    language: string;
    /** One rg glob, e.g. '*.{ts,tsx,js,jsx,mjs,cjs}'. */
    glob: string;
    /** Patterns that only make sense in specific files (Rails routes.rb, Play routes, Django urls.py). */
    extraGlobs?: { glob: string; patterns: SurfacePattern[] }[];
    patterns: SurfacePattern[];
}

export interface SurfaceHit {
    file: string;
    line: number;
    text: string;
    patternId: string;
    role: SurfaceRole;
    language: string;
    vulnClass?: VulnClass;
    cwe?: string;
    framework?: string;
}

export interface SurfaceFileSummary {
    entryPoints: number;
    authChecks: number;
    sinks: number;
    classes: VulnClass[];
}

export interface SurfaceMap {
    /** Languages actually scanned. */
    languages: string[];
    hits: SurfaceHit[];
    files: Record<string, SurfaceFileSummary>;
    errors: { language: string; patternIds: string[]; message: string }[];
}

export type GrepFn = (
    pattern: string,
    path: string,
    glob?: string,
) => Promise<string>;
