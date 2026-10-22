/**
 * The one rule for what a custom agent CLI install command may be (#2172).
 * The save DTO, the config schema and the sandbox provisioner all call
 * `checkCliInstallCommand`, so what is accepted on save is exactly what can
 * run later.
 *
 * An install is a single package-manager command, without shell syntax, whose
 * every package spec is pinned to an exact version (`pkg@1.2.3`,
 * `pkg==1.2.3`, `module@v1.2.3`) or a sha256 digest (`pkg@sha256:<hex>`).
 * Each spec is matched whole: a pin somewhere inside it (`pkg@1.2.3x`,
 * `pkg@1.2.3@latest`) is not a pin. Tags (`@latest`), ranges (`^`, `~`,
 * `>=`), URLs, VCS sources and local paths are refused.
 */

/** Installers whose output lands in the CLI user's own bin directory. */
const INSTALLERS: Record<string, string[]> = {
    npm: ['install', 'i', 'add'],
    pnpm: ['add', 'install', 'i'],
    yarn: ['add', 'global'],
    pip: ['install'],
    pip3: ['install'],
    pipx: ['install'],
    uv: ['tool', 'pip'],
    go: ['install'],
    cargo: ['install'],
};

/** Anything a shell would interpret. Install commands are split on spaces and
 *  run as argv, so none of these may appear. */
const SHELL_META = /[;&|<>`$\\(){}'"\n\r\t*?!~#^]/;

/** Flags an install may carry. Anything else (registries, index URLs, git
 *  sources, editable installs) could fetch something other than the pin. */
const ALLOWED_INSTALL_FLAGS = new Set([
    '-g',
    '--global',
    '--ignore-scripts',
    '--user',
    '--no-deps',
    '--only-binary=:all:',
    '--locked',
    '--force',
    '--quiet',
    '-q',
]);

const SEMVER = String.raw`v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const PEP440 = String.raw`\d+\.\d+\.\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?`;
const SHA256 = String.raw`sha256:[a-f0-9]{64}`;

/** `name@x.y.z` or `name@sha256:<hex>`: npm (scoped too), cargo, go modules. */
const AT_PINNED_SPEC = new RegExp(
    String.raw`^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._/-]*@(?:${SEMVER}|${SHA256})$`,
    'i',
);
/** `name==x.y.z` (pip, pipx, uv), with optional extras. */
const EQ_PINNED_SPEC = new RegExp(
    String.raw`^[a-z0-9][a-z0-9._-]*(?:\[[a-z0-9,._-]+\])?===?${PEP440}$`,
    'i',
);

/** A token that names a URL, VCS source or local path, not a registry package. */
const NOT_REGISTRY = /:\/\/|^(git|hg|svn|bzr)\+|^file:|^[./~]/i;

const PIP_FAMILY = new Set(['pip', 'pip3', 'pipx', 'uv']);

export function isPinnedPackageSpec(installer: string, spec: string): boolean {
    if (NOT_REGISTRY.test(spec)) return false;
    return PIP_FAMILY.has(installer)
        ? EQ_PINNED_SPEC.test(spec)
        : AT_PINNED_SPEC.test(spec);
}

export type CliInstallCheck =
    | { ok: true; argv: string[]; installer: string }
    | { ok: false; reason: string };

export function checkCliInstallCommand(
    install: string | undefined | null,
): CliInstallCheck {
    const command = (install ?? '').trim();
    if (!command) return { ok: false, reason: 'no install command' };
    if (SHELL_META.test(command)) {
        return {
            ok: false,
            reason: 'install command must be a single command without shell syntax',
        };
    }

    const argv = command.split(/\s+/);
    const [installer, sub] = argv;
    const subcommands = INSTALLERS[installer];
    if (!subcommands) {
        return {
            ok: false,
            reason: `unsupported installer "${installer}" (use ${Object.keys(INSTALLERS).join(', ')})`,
        };
    }
    if (!subcommands.includes(sub)) {
        return {
            ok: false,
            reason: `"${installer} ${sub ?? ''}" is not an install command`,
        };
    }

    // `uv tool install` / `uv pip install` and `yarn global add` carry a second word.
    const twoWords =
        installer === 'uv' || (installer === 'yarn' && sub === 'global');
    if (twoWords && argv[2] !== (installer === 'uv' ? 'install' : 'add')) {
        return { ok: false, reason: 'not an install command' };
    }
    const start = twoWords ? 3 : 2;

    const positional: string[] = [];
    for (let i = start; i < argv.length; i++) {
        const token = argv[i];
        if (token.startsWith('-')) {
            if (!ALLOWED_INSTALL_FLAGS.has(token)) {
                return {
                    ok: false,
                    reason: `install flag "${token}" is not allowed`,
                };
            }
            continue;
        }
        positional.push(token);
    }

    if (!positional.length) {
        return { ok: false, reason: 'install command names no package' };
    }
    const notRegistry = positional.find((token) => NOT_REGISTRY.test(token));
    if (notRegistry) {
        return {
            ok: false,
            reason: `"${notRegistry}" is not a registry package`,
        };
    }
    const unpinned = positional.filter(
        (token) => !isPinnedPackageSpec(installer, token),
    );
    if (unpinned.length) {
        return {
            ok: false,
            reason: `every package must pin an exact version (unpinned: ${unpinned.join(', ')})`,
        };
    }

    return { ok: true, argv, installer };
}

/** Reason the install command is refused, or null when it is acceptable. */
export function cliInstallProblem(install: unknown): string | null {
    if (typeof install !== 'string') return 'install must be a string';
    const check = checkCliInstallCommand(install);
    return check.ok === false ? check.reason : null;
}
