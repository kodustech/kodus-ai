import { isFileMatchingGlobCaseInsensitive } from '@libs/common/utils/glob-utils';

/**
 * Files that hold credentials when a repository commits them: env files,
 * private keys and keystores. Their content would reach the model provider
 * and the review's trace, so no agent tool returns it.
 */
export const SECRET_FILE_GLOBS = [
    '**/.env*',
    '**/*.pem',
    '**/*.key',
    '**/*.p12',
    '**/*.pfx',
    '**/*.jks',
    '**/*.keystore',
    '**/id_rsa*',
    '**/id_dsa*',
    '**/id_ecdsa*',
    '**/id_ed25519*',
];

/** Env file templates: variable names, not values. */
const ENV_TEMPLATE = /(^|\/)\.env\.(example|sample|template|dist)$/i;

export function isSecretFilePath(filePath: string): boolean {
    const normalized = filePath.replace(/^\.?\/+/, '');
    if (!normalized || ENV_TEMPLATE.test(normalized)) return false;
    return isFileMatchingGlobCaseInsensitive(normalized, SECRET_FILE_GLOBS);
}

export function secretFileRefusal(filePath: string): string {
    return `${filePath} is a secret file (credentials or keys); its content is not shown.`;
}

/**
 * Drops the lines of grep output that come from a secret file. rg prints
 * `path:line:text` for a match and `path-line-text` for a context line;
 * with namesOnly, the bare path. A path can hold ":" or "-" itself, so every
 * candidate prefix ending before a line number is tested.
 */
export function withoutSecretFileLines(output: string): string {
    const lines = output.split('\n');
    const kept = lines.filter((line) => !lineFromSecretFile(line));
    if (kept.length === lines.length) return output;
    // A `--` group separator left with nothing between two others.
    return kept
        .filter(
            (line, i) =>
                line !== '--' ||
                (i > 0 && i < kept.length - 1 && kept[i + 1] !== '--'),
        )
        .join('\n');
}

function lineFromSecretFile(line: string): boolean {
    if (isSecretFilePath(line.trim())) return true;
    const boundary = /[:-]\d+[:-]/g;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(line))) {
        if (isSecretFilePath(line.slice(0, match.index))) return true;
    }
    return false;
}
