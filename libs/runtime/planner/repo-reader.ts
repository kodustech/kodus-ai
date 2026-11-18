import { posix } from 'path';

import { redactPatterns } from '@libs/runtime/redaction';
import { SECRET_NAME } from '@libs/runtime/run/recipe-inference';

/**
 * What the recipe author may read of a repository: one commit, read only. The
 * production adapter goes through the org's Git integration; the eval reads a
 * local checkout at the same commit.
 */
export interface RepoReader {
    /** The entries of one directory at the commit ('' is the root). Directories end with '/'. */
    list(dir: string): Promise<string[]>;
    /** The file's text at the commit, or null when there is none. At most `maxBytes`. */
    read(path: string, maxBytes: number): Promise<string | null>;
    /** Whether the file is at the commit, without reading it when the reader can tell otherwise. Throws when it cannot tell. */
    exists?(path: string): Promise<boolean>;
    /** Every file path at the commit, when the reader has the whole tree in one call. */
    paths?(): Promise<string[]>;
    /**
     * Several files' text at the commit in one call to the platform (a GraphQL
     * batch of objects, an archive), when the reader has one: each path to its
     * text, at most `maxBytes`, or null when there is none. A path left out of
     * the answer reads as none. Throws when the call fails. Callers ask for at
     * most READ_MANY_MAX paths at once.
     */
    readMany?(paths: string[], maxBytes: number): Promise<Map<string, string | null>>;
}

/** The most paths one readMany call asks for. */
export const READ_MANY_MAX = 50;

/**
 * Whether a file is at the commit: the reader's own answer, else a one-byte
 * read. A path the reader refuses is no file; any other failure (a Git API
 * error) is thrown, never read as "not there".
 */
export async function fileExists(reader: RepoReader, path: string): Promise<boolean> {
    try {
        return reader.exists ? await reader.exists(path) : (await reader.read(path, 1)) !== null;
    } catch (e) {
        if (e instanceof RepoPathError) return false;
        throw e;
    }
}

/**
 * How to ask whether a directory is at the commit, or undefined when the
 * reader cannot tell a directory from a missing one (it lists no whole tree,
 * so an empty listing proves nothing). A path the reader refuses is no
 * directory; any other failure (a Git API error) is thrown, never read as
 * "not there".
 */
export async function directoryExistsCheck(reader: RepoReader): Promise<((path: string) => Promise<boolean>) | undefined> {
    if (!reader.paths) return undefined;
    try {
        await reader.paths();
    } catch (e) {
        if (e instanceof RepoPathError) return undefined;
        throw e;
    }
    return async (path: string) => {
        try {
            return (await reader.list(path)).length > 0;
        } catch (e) {
            if (e instanceof RepoPathError) return false;
            throw e;
        }
    };
}

export const READ_LIMITS = {
    /** Bytes of one file the agent sees; the rest is cut with a note. */
    fileBytes: 64 * 1024,
    /** Entries of one directory listing. */
    listEntries: 400,
    /** Tool calls that read (list or read) in one run. */
    reads: 60,
} as const;

export class RepoPathError extends Error {}

/**
 * A repository-relative path, normalized, or an error. Never absolute, never
 * above the root, never inside .git, never a control character.
 */
export function repoPath(input: unknown, opts: { dir?: boolean } = {}): string {
    if (typeof input !== 'string') throw new RepoPathError('the path must be a string');
    const raw = input.trim().replace(/^\.\/+/, '');
    if (opts.dir && (raw === '' || raw === '.' || raw === '/')) return '';
    if (raw.length > 512) throw new RepoPathError('the path is too long');
    // eslint-disable-next-line no-control-regex -- matching a control character is the check itself
    if (/[\u0000-\u001f\u007f\\]/.test(raw)) throw new RepoPathError('the path has a control character or a backslash');
    if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new RepoPathError('the path must be relative to the repository root');
    const n = posix.normalize(raw).replace(/\/+$/, '');
    if (n === '..' || n.startsWith('../')) throw new RepoPathError('the path leaves the repository');
    if (n === '.git' || n.startsWith('.git/') || n.includes('/.git/') || n.endsWith('/.git')) throw new RepoPathError('.git is not readable');
    return n === '.' ? '' : n;
}

/**
 * Files whose values are secrets by name: their content never reaches the
 * model. Env files, shell env hooks, Terraform variables and state, Git and
 * registry credentials, kubeconfigs, keys and keystores, and per-environment
 * .NET and Spring settings.
 */
const SECRET_FILE = new RegExp(
    '(^|/)(' +
        [
            '\\.env(\\.(?!example$|sample$|template$|dist$|defaults$)[^/]+)?',
            '[^/]+\\.env',
            '\\.envrc',
            '\\.npmrc',
            '\\.pypirc',
            '\\.netrc',
            '\\.dockercfg',
            '\\.git-credentials',
            '\\.docker/config\\.json',
            '\\.kube/config',
            'kubeconfig(\\.[^/]+)?',
            'id_(rsa|dsa|ecdsa|ed25519)',
            '[^/]*\\.(pem|key|p12|pfx|jks|keystore)',
            '[^/]*\\.tfvars(\\.json)?',
            '[^/]*\\.tfstate(\\.backup)?',
            'credentials(\\.[^/]+)?',
            'secrets?\\.(ya?ml|json|toml)',
            'appsettings\\.[^/]+\\.json',
            'application-[^/]+\\.properties',
        ].join('|') +
        ')$',
    'i',
);

/** Whether the file is one whose content is withheld (only its variable names are shown, for env files). */
export const isSecretFile = (path: string) => SECRET_FILE.test(path);

/** Secret files written as NAME=value lines: the model sees their names, never their values. */
const ENV_STYLE_FILE = /(^|\/)(\.env(\.[^/]+)?|[^/]+\.env|\.envrc)$/i;

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]{0,127})\s*=/;

/** Files read as configuration: a secret-named key's value in them is masked before the model sees it. */
const CONFIG_FILE = /(^|\/)([^/]*\.(ya?ml|json|jsonc|json5|toml|ini|cfg|conf|properties|env|hcl|xml|plist)|\.env[^/]*|[^/]*Dockerfile[^/]*|[^/]*\.dockerfile)$/i;

/** `KEY=value`, `key: value`, `"key": "value"`, `- KEY=value`, `export KEY=value`, `ENV KEY=value`. */
const ASSIGNMENT = /^(\s*(?:-\s+)?(?:export\s+|ENV\s+|ARG\s+)?["']?)([A-Za-z_][A-Za-z0-9_.-]{0,127})(["']?\s*[:=]\s*)(\S.*)$/;

/** A value that names another variable (`${DB_PASSWORD}`) instead of holding the secret. */
const VARIABLE_REFERENCE = /^["']?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?["']?,?$/;

export const SECRET_VALUE_MARKER = '[redacted:secret-name]';

/**
 * A configuration file's text with the value of every secret-named key
 * masked (the recipe's secret-name rule), whatever the pattern pass knows of
 * the value. Other files come back unchanged.
 */
export function maskSecretAssignments(path: string, text: string): string {
    if (!CONFIG_FILE.test(path)) return text;
    return text
        .split('\n')
        .map((line) => {
            const m = ASSIGNMENT.exec(line);
            if (!m || !SECRET_NAME.test(m[2])) return line;
            const value = m[4].trim();
            if (VARIABLE_REFERENCE.test(value) || /^(["']{2}|[{[]),?$/.test(value)) return line;
            return `${m[1]}${m[2]}${m[3]}${SECRET_VALUE_MARKER}${value.endsWith(',') ? ',' : ''}`;
        })
        .join('\n');
}

/**
 * Text the model may see of a non-secret file: secret-named config values
 * masked, then every known secret pattern redacted. With `keepLines`, the
 * text keeps its line count (redactPatterns), so line numbers stay the file's.
 */
export const redactForModel = (path: string, text: string, opts: { keepLines?: boolean } = {}): string =>
    redactPatterns(maskSecretAssignments(path, text), undefined, opts).text;

/**
 * What the model sees of a file: the text with secret-named config values
 * masked and every known secret pattern redacted, cut at the limit. An
 * env-style secret file gives only its variable names; any other secret file
 * gives nothing.
 */
export function modelView(path: string, text: string, maxBytes: number = READ_LIMITS.fileBytes): string {
    if (isSecretFile(path)) {
        if (!ENV_STYLE_FILE.test(path)) return `[${path} is a secret file; its content is not shown]`;
        const names = text
            .split('\n')
            .map((l) => ENV_LINE.exec(l)?.[1])
            .filter((n): n is string => !!n);
        return `[${path} holds secrets; only its variable names are shown]\n${[...new Set(names)].join('\n')}`;
    }
    const cut = Buffer.byteLength(text) > maxBytes;
    const body = cut ? Buffer.from(text).subarray(0, maxBytes).toString('utf8') : text;
    const redacted = redactForModel(path, body);
    return cut ? `${redacted}\n[cut at ${maxBytes} bytes]` : redacted;
}
