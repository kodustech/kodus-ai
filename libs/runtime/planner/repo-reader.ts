import { posix } from 'path';

import { redactPatterns } from '@libs/runtime/redaction';

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
}

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
    if (/[\u0000-\u001f\u007f\\]/.test(raw)) throw new RepoPathError('the path has a control character or a backslash');
    if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new RepoPathError('the path must be relative to the repository root');
    const n = posix.normalize(raw).replace(/\/+$/, '');
    if (n === '..' || n.startsWith('../')) throw new RepoPathError('the path leaves the repository');
    if (n === '.git' || n.startsWith('.git/') || n.includes('/.git/') || n.endsWith('/.git')) throw new RepoPathError('.git is not readable');
    return n === '.' ? '' : n;
}

/** Files whose values are secrets by name: their content never reaches the model. */
const SECRET_FILE =
    /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$|defaults$)[^/]+)?|\.npmrc|\.pypirc|\.netrc|\.dockercfg|id_(rsa|dsa|ecdsa|ed25519)|[^/]*\.(pem|key|p12|pfx|jks|keystore)|credentials(\.[^/]+)?|secrets?\.(ya?ml|json|toml))$/i;

/** Whether the file is one whose content is withheld (only its variable names are shown, for .env files). */
export const isSecretFile = (path: string) => SECRET_FILE.test(path);

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]{0,127})\s*=/;

/**
 * What the model sees of a file: the text with every known secret pattern
 * redacted, cut at the limit. A .env-style secret file gives only its
 * variable names; any other secret file gives nothing.
 */
export function modelView(path: string, text: string, maxBytes: number = READ_LIMITS.fileBytes): string {
    if (isSecretFile(path)) {
        if (!/(^|\/)\.env/i.test(path)) return `[${path} is a secret file; its content is not shown]`;
        const names = text
            .split('\n')
            .map((l) => ENV_LINE.exec(l)?.[1])
            .filter((n): n is string => !!n);
        return `[${path} holds secrets; only its variable names are shown]\n${[...new Set(names)].join('\n')}`;
    }
    const cut = Buffer.byteLength(text) > maxBytes;
    const body = cut ? Buffer.from(text).subarray(0, maxBytes).toString('utf8') : text;
    const { text: redacted } = redactPatterns(body);
    return cut ? `${redacted}\n[cut at ${maxBytes} bytes]` : redacted;
}
