import {
    DoctorReport,
    DoctorResult,
    DoctorStatus,
    ReviewsVerdict,
} from './doctor.types';

/** Worst first: what stops reviews, then what degrades them, then the rest. */
export const STATUS_ORDER: DoctorStatus[] = [
    'fail',
    'warn',
    'unknown',
    'info',
    'skip',
    'ok',
];

export function verdictOf(results: DoctorResult[]): ReviewsVerdict {
    if (results.some((r) => r.status === 'fail')) {
        return 'NOT_RUNNING';
    }
    if (results.some((r) => r.status === 'warn')) {
        return 'DEGRADED';
    }
    return 'OK';
}

export function sortResults(results: DoctorResult[]): DoctorResult[] {
    return results
        .map((r, i) => ({ r, i }))
        .sort(
            (a, b) =>
                STATUS_ORDER.indexOf(a.r.status) -
                    STATUS_ORDER.indexOf(b.r.status) || a.i - b.i,
        )
        .map(({ r }) => r);
}

/**
 * Env keys whose values must never reach the output. Matched by name so a new
 * secret var is covered without listing it here.
 */
const SECRET_KEY_RE =
    /(KEY|SECRET|TOKEN|PASSWORD|PASS|CREDENTIAL|PRIVATE|URI|DSN)$/i;

/** Values under 8 chars are too common to scrub safely (e.g. "true", "3001"). */
const MIN_SECRET_LENGTH = 8;

export function collectSecretValues(env: NodeJS.ProcessEnv): string[] {
    return Object.entries(env)
        .filter(
            ([key, value]) =>
                SECRET_KEY_RE.test(key) &&
                typeof value === 'string' &&
                value.length >= MIN_SECRET_LENGTH,
        )
        .map(([, value]) => value as string)
        .sort((a, b) => b.length - a.length);
}

const INLINE_SECRET_PATTERNS: RegExp[] = [
    // provider-masked keys still leak their prefix and suffix
    // (OpenAI: "sk-svcac****…VeAA")
    /\b[A-Za-z0-9_-]*\*{4,}[A-Za-z0-9_-]*/g,
    // credentials embedded in URLs: scheme://user:pass@host
    /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    // bearer / basic headers
    /\b(bearer|basic)\s+[a-z0-9._~+/=-]{8,}/gi,
    // well-known token prefixes. Case-sensitive on purpose: `KODUS_LICENSE_KEY`
    // is an env var name the fixes cite, `kodus_…` is a team key.
    /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[A-Za-z0-9_-]{20,}|kodus_[A-Za-z0-9_-]{8,})/g,
];

export function redact(text: string, secrets: string[]): string {
    let out = text;
    for (const secret of secrets) {
        out = out.split(secret).join('<redacted>');
    }
    out = out.replace(INLINE_SECRET_PATTERNS[0], '<redacted>');
    out = out.replace(INLINE_SECRET_PATTERNS[1], '$1<redacted>@');
    out = out.replace(INLINE_SECRET_PATTERNS[2], '$1 <redacted>');
    out = out.replace(INLINE_SECRET_PATTERNS[3], '<redacted>');
    return out;
}

export function redactResult(
    result: DoctorResult,
    secrets: string[],
): DoctorResult {
    const clean = (v?: string) => (v === undefined ? v : redact(v, secrets));
    return {
        ...result,
        title: clean(result.title),
        impact: clean(result.impact),
        fix: clean(result.fix),
        scope: clean(result.scope),
    };
}

export function buildReport(params: {
    results: DoctorResult[];
    env: NodeJS.ProcessEnv;
    startedAt: number;
}): DoctorReport {
    const secrets = collectSecretValues(params.env);
    const results = sortResults(
        params.results.map((r) => redactResult(r, secrets)),
    );
    return {
        verdict: verdictOf(results),
        version: params.env.RELEASE_VERSION || 'unknown',
        generatedAt: new Date().toISOString(),
        durationMs: Date.now() - params.startedAt,
        results,
    };
}
