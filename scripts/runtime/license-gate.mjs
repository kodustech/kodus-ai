#!/usr/bin/env node
// ADR-068 licence gate for the Node packages each shipped image contains.
//
//   node scripts/runtime/license-gate.mjs --image=backend --project=.
//   node scripts/runtime/license-gate.mjs --image=web --project=apps/web
//
// It reads the installed tree (`pnpm install --ignore-scripts` is enough; no
// network) and walks the production closure of the project's package.json:
// `dependencies` and `optionalDependencies`, then each package's own
// dependencies, optional dependencies and required peers, resolved the way
// Node resolves them. devDependencies are never followed, so a dev-only
// package (the e-mail preview's Next.js and its sharp) does not count against
// an image that does not ship it. The backend image installs exactly this
// closure (`pnpm install --prod`, docker/Dockerfile); the web image ships a
// traced subset of it (Next.js standalone), so this gate over-approximates.
//
// A package passes when its SPDX expression is satisfied by the allowlist
// (MIT, Apache-2.0, BSD, ISC), by a licence reviewed for every image in
// license-exceptions.json `licenses`, or by a reviewed exception for that
// package, image and exact licence in `packages`. Everything else fails,
// including a missing or unparsable licence. Copyleft, weak copyleft (MPL,
// LGPL, EPL...) and source-available licences can never be reviewed for every
// image: only one package at a time.
//
// Exit codes: 0 every package passes, 1 a package fails, 2 setup error.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED = new Set([
    'MIT',
    'MIT-0',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    '0BSD',
    'ISC',
]);

/** Never allowed for every image: each use is reviewed package by package. */
const RESTRICTED =
    /^(A?GPL|LGPL|MPL|EPL|EUPL|CDDL|CPL|OSL|SSPL|BUSL|Elastic|FSL|CC-BY-NC|CC-BY-SA|CC-BY-ND|Commons-Clause|SISSL|Sleepycat|RPL|QPL|Watcom|NPL|LicenseRef|SEE LICENSE|UNLICENSED)/i;

export function isRestricted(id) {
    return RESTRICTED.test(id);
}

/** SPDX licence ids match case-insensitively. */
const canonical = (id) => id.toLowerCase();
const ALLOWED_CANONICAL = new Set([...ALLOWED].map(canonical));

/** The licence ids an SPDX expression names, or null when it does not parse. */
export function parseSpdx(expression) {
    if (typeof expression !== 'string' || !expression.trim()) return null;
    const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
    let at = 0;
    const peek = () => tokens[at];
    const take = () => tokens[at++];
    function primary() {
        const token = take();
        if (token === '(') {
            const inner = or();
            if (take() !== ')') throw new Error('unbalanced');
            return inner;
        }
        if (!token || /^(AND|OR|WITH|\))$/i.test(token))
            throw new Error('unexpected');
        let node = { id: token.replace(/\+$/, '') };
        if (/^WITH$/i.test(peek() ?? '')) {
            take();
            const exception = take();
            if (!exception) throw new Error('with');
            node = { id: node.id, with: exception };
        }
        return node;
    }
    function and() {
        const parts = [primary()];
        while (/^AND$/i.test(peek() ?? '')) {
            take();
            parts.push(primary());
        }
        return parts.length === 1 ? parts[0] : { and: parts };
    }
    function or() {
        const parts = [and()];
        while (/^OR$/i.test(peek() ?? '')) {
            take();
            parts.push(and());
        }
        return parts.length === 1 ? parts[0] : { or: parts };
    }
    try {
        const tree = or();
        return at === tokens.length ? tree : null;
    } catch {
        return null;
    }
}

/** Whether the expression is satisfied when `accepts(id)` says which ids are acceptable. */
export function satisfies(tree, accepts) {
    if (tree.or) return tree.or.some((part) => satisfies(part, accepts));
    if (tree.and) return tree.and.every((part) => satisfies(part, accepts));
    return accepts(tree.id);
}

/** The licence a package.json declares, as one SPDX expression, or undefined. */
export function declaredLicense(pkg) {
    const one = (value) =>
        typeof value === 'string'
            ? value
            : typeof value?.type === 'string'
              ? value.type
              : undefined;
    if (pkg.license !== undefined) return one(pkg.license);
    if (Array.isArray(pkg.licenses)) {
        const ids = pkg.licenses.map(one);
        if (!ids.length || ids.some((id) => !id)) return undefined;
        // The legacy array lists alternatives.
        return ids.length === 1 ? ids[0] : `(${ids.join(' OR ')})`;
    }
    return undefined;
}

const nameMatches = (pattern, name) =>
    pattern.endsWith('*')
        ? name.startsWith(pattern.slice(0, -1))
        : pattern === name;

export function validateExceptions(exceptions) {
    const problems = [];
    for (const [id, reason] of Object.entries(exceptions.licenses ?? {})) {
        if (isRestricted(id))
            problems.push(`licence ${id} cannot be reviewed for every image`);
        if (typeof reason !== 'string' || reason.length < 20)
            problems.push(`licence ${id} needs a reason`);
    }
    for (const entry of exceptions.packages ?? []) {
        if (
            typeof entry.package !== 'string' ||
            typeof entry.license !== 'string' ||
            !Array.isArray(entry.images) ||
            !entry.images.length ||
            typeof entry.reason !== 'string' ||
            entry.reason.length < 20
        )
            problems.push(
                `package exception ${JSON.stringify(entry.package)} needs package, license, images and a reason`,
            );
    }
    return problems;
}

/**
 * The production closure of `projectDir`: every installed package reached
 * from its package.json, keyed by the package's real directory.
 */
export function productionClosure(projectDir) {
    const root = realpathSync(projectDir);
    // node_modules may be a link (a worktree); resolution stops at its parent.
    const modules = realpathSync(join(root, 'node_modules'));
    const top = dirname(modules);
    const shown = (dir) =>
        dir.startsWith(modules)
            ? join('node_modules', relative(modules, dir))
            : relative(root, dir);
    const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const seen = new Map();
    const missing = [];
    const resolveFrom = (fromDir, name) => {
        let dir = fromDir;
        for (;;) {
            const candidate = join(dir, 'node_modules', name, 'package.json');
            if (existsSync(candidate)) return dirname(realpathSync(candidate));
            if (dir === root || dir === top || dirname(dir) === dir)
                return undefined;
            dir = dirname(dir);
        }
    };
    const queue = [];
    const enqueue = (fromDir, deps, optional, from) => {
        for (const name of Object.keys(deps ?? {})) {
            const dir = resolveFrom(fromDir, name);
            if (!dir) {
                if (!optional.has(name)) missing.push(`${name} (from ${from})`);
                continue;
            }
            if (!seen.has(dir)) {
                seen.set(dir, undefined);
                queue.push(dir);
            }
        }
    };
    const optionalOf = (pkg) =>
        new Set([
            ...Object.keys(pkg.optionalDependencies ?? {}),
            ...Object.entries(pkg.peerDependenciesMeta ?? {})
                .filter(([, meta]) => meta?.optional)
                .map(([name]) => name),
        ]);
    enqueue(
        root,
        { ...rootPkg.dependencies, ...rootPkg.optionalDependencies },
        optionalOf(rootPkg),
        'package.json',
    );
    while (queue.length) {
        const dir = queue.shift();
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        seen.set(dir, pkg);
        const optional = optionalOf(pkg);
        // A peer that is not installed is the consumer's choice, never a gap.
        const peers = Object.fromEntries(
            Object.entries(pkg.peerDependencies ?? {}).filter(
                ([name]) => resolveFrom(dir, name),
            ),
        );
        enqueue(
            dir,
            { ...pkg.dependencies, ...pkg.optionalDependencies, ...peers },
            optional,
            pkg.name,
        );
    }
    return {
        packages: [...seen.entries()].map(([dir, pkg]) => ({
            dir: shown(dir),
            name: pkg.name,
            version: pkg.version,
            license: declaredLicense(pkg),
        })),
        missing,
    };
}

/** Each package of the closure that the allowlist and the reviewed exceptions do not cover. */
export function violations(packages, image, exceptions) {
    const reviewedForAll = new Set(
        Object.keys(exceptions.licenses ?? {}).map(canonical),
    );
    const out = [];
    for (const pkg of packages) {
        const reviewed = (exceptions.packages ?? []).some(
            (entry) =>
                entry.images.includes(image) &&
                nameMatches(entry.package, pkg.name ?? '') &&
                entry.license === (pkg.license ?? 'UNKNOWN'),
        );
        if (reviewed) continue;
        const tree = parseSpdx(pkg.license);
        const ok =
            tree &&
            satisfies(
                tree,
                (id) =>
                    ALLOWED_CANONICAL.has(canonical(id)) ||
                    (reviewedForAll.has(canonical(id)) && !isRestricted(id)),
            );
        if (!ok)
            out.push({
                name: pkg.name,
                version: pkg.version,
                license: pkg.license ?? 'UNKNOWN',
                dir: pkg.dir,
            });
    }
    return out.sort((a, b) => `${a.name}`.localeCompare(`${b.name}`));
}

function main(argv) {
    const args = Object.fromEntries(
        argv.map((arg) => {
            const [flag, ...rest] = arg.split('=');
            return [flag, rest.join('=')];
        }),
    );
    const image = args['--image'];
    const project = args['--project'];
    if (!image || !project) {
        process.stderr.write('usage: license-gate.mjs --image=<name> --project=<dir>\n');
        return 2;
    }
    const exceptionsPath =
        args['--exceptions'] ||
        join(dirname(fileURLToPath(import.meta.url)), 'license-exceptions.json');
    const exceptions = JSON.parse(readFileSync(exceptionsPath, 'utf8'));
    const problems = validateExceptions(exceptions);
    if (problems.length) {
        for (const problem of problems) process.stderr.write(`exceptions: ${problem}\n`);
        return 2;
    }
    const { packages, missing } = productionClosure(resolve(project));
    if (missing.length) {
        for (const name of missing)
            process.stderr.write(`not installed: ${name}\n`);
        process.stderr.write('install the project first (pnpm install --frozen-lockfile --ignore-scripts)\n');
        return 2;
    }
    const failing = violations(packages, image, exceptions);
    for (const pkg of failing)
        process.stdout.write(
            `${image}: ${pkg.name}@${pkg.version} is ${pkg.license} (${pkg.dir})\n`,
        );
    process.stdout.write(
        `${image}: ${packages.length} production packages, ${failing.length} outside the ADR-068 allowlist and its reviewed exceptions\n`,
    );
    return failing.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    process.exitCode = main(process.argv.slice(2));
