import { MIRROR_BUILD_ARGS } from '@libs/runtime/protocol/egress-catalog';

// A build reaches package registries only through the cell's read-only mirror
// (docs/runtime/egress-allowlist.md §16, G1): the cell passes the mirror as
// build args, which a RUN sees only when its stage declares them. So each
// stage of a Dockerfile Kody writes that installs packages declares the
// names of its ecosystem, right after its FROM; an ARG with no value stays
// unset, so a cell without a mirror builds as before (CI is the exception: the cell
// passes CI=true to every build, so each stage with a RUN declares it).

const INSTALLS: Array<{ family: keyof typeof MIRROR_BUILD_ARGS; run: RegExp }> = [
    { family: 'npm', run: /\b(?:npm|npx|pnpm|yarn|corepack)\b/ },
    { family: 'pypi', run: /\b(?:pip3?|pipx|uv)\b|\bpython3?\s+-m\s+pip\b/ },
    // Prisma's engines and mongodb-memory-server's binaries download at install or generate time.
    { family: 'artifacts', run: /\bprisma\b|mongodb-memory-server/ },
    { family: 'go', run: /\bgo\s+(?:mod|build|get|install|work|generate|test)\b/ },
    // The Runtime builds like CI (GitHub Actions always sets CI=true, and tools change behavior on it): every stage with a RUN.
    { family: 'ci', run: /\S/ },
];

// A Nuxt install runs `nuxt prepare` as a postinstall, which loads @nuxt/telemetry: consent and a POST to
// telemetry.nuxt.com, a host a build does not reach. It never fails the prepare (5 s timeout, error swallowed), so the
// env only removes the refused connection; no repository file is touched and no script is skipped.
const NUXT_TELEMETRY_ENV = 'NUXT_TELEMETRY_DISABLED';

const FROM = /^\s*FROM\s/i;
const RUN = /^\s*RUN\s/i;
const ARG = /^\s*ARG\s+(.+)$/i;

/** The Dockerfile with the mirror's build args declared in each stage that installs, and what was added. */
export function declareMirrorBuildArgs(path: string, content: string): { content: string; changes: string[] } {
    const lines = content.split('\n');
    // A stage is a FROM and the lines up to the next FROM (continuation lines included).
    const starts = lines.flatMap((l, i) => (FROM.test(l) ? [i] : []));
    if (!starts.length) return { content, changes: [] };
    const inserts = new Map<number, string[]>();
    const added = new Set<string>();
    starts.forEach((start, s) => {
        const end = starts[s + 1] ?? lines.length;
        const stage = lines.slice(start, end);
        const declared = new Set(stage.flatMap((l) => (ARG.exec(l)?.[1] ?? '').split(/\s+/).map((a) => a.split('=')[0]).filter(Boolean)));
        const runs = stage.filter((l, i) => RUN.test(l) || (i > 0 && /\\\s*$/.test(stage[i - 1]))).join('\n');
        const nuxtEnv = /\bNUXT_TELEMETRY_DISABLED\b/.test(stage.join('\n')) || !INSTALLS[0].run.test(runs) ? [] : [`ENV ${NUXT_TELEMETRY_ENV}=1`];
        const names = INSTALLS.filter((x) => x.run.test(runs)).flatMap((x) => MIRROR_BUILD_ARGS[x.family]).filter((n) => !declared.has(n));
        if (!names.length && !nuxtEnv.length) return;
        // After the FROM and its continuation lines.
        let at = start;
        while (/\\\s*$/.test(lines[at]) && at + 1 < end) at++;
        inserts.set(at, [...names.map((n) => `ARG ${n}`), ...nuxtEnv]);
        names.forEach((n) => added.add(n));
        if (nuxtEnv.length) added.add(NUXT_TELEMETRY_ENV);
    });
    if (!inserts.size) return { content, changes: [] };
    const out: string[] = [];
    lines.forEach((l, i) => {
        out.push(l);
        const add = inserts.get(i);
        if (add) out.push(...add);
    });
    return {
        content: out.join('\n'),
        changes: [`${path}: declared ${[...added].join(', ')}: a build installs only through the cell's read-only mirror, which the cell passes as these build args`],
    };
}
