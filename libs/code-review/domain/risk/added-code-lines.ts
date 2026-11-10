/** Undefined fragments cannot certify test evidence or a low-risk control-flow check. */
export function addedCodeLines(
    patch: string,
    filename: string,
): string | undefined {
    const hashComments = filename.toLowerCase().endsWith('.py');
    const templateExpressions = /\.[cm]?[jt]sx?$/i.test(filename);
    const hunks = patch.split(/^@@.*@@.*$/m);
    // A full unified diff has a preamble before its first hunk. Inside a
    // hunk, even `+++value` is added code, not a `+++ b/file` header.
    if (hunks.length > 1) hunks.shift();
    const fragments = hunks.map((hunk) => {
        const lines = hunk
            .split('\n')
            .filter((line) => line.startsWith(' ') || line.startsWith('+'));
        if (!lines.length) return '';
        const source = lines.map((line) => line.slice(1)).join('\n');
        const addedOnly = (text: string) =>
            text
                .split('\n')
                .filter((_, index) => lines[index].startsWith('+'))
                .join('\n');
        // Missing language context cannot certify a lexical signal;
        // callers keep the judgment unknown rather than treating it as safe.
        if (
            (/\.cs$/i.test(filename) && /@\$?"|"{3,}/.test(source)) ||
            (/\.rs$/i.test(filename) &&
                /\b(?:br|r)#*"|'\p{ID_Start}\p{ID_Continue}*(?![\p{ID_Continue}'])/u.test(
                    source,
                ))
        )
            return undefined;
        let result = '';
        let delimiter = '';
        let pythonInterpolation = false;
        let blockComment = false;
        let lineComment = false;
        let regexLiteral = false;
        let regexClass = false;
        let previous = '';
        const interpolations: {
            depth: number;
            delimiter: string;
            python: boolean;
        }[] = [];
        for (let index = 0; index < source.length; index++) {
            const char = source[index];
            const next = source[index + 1];
            if (char === '\n') {
                // A diff fragment cannot prove which quote opened in JSX
                // text or in code outside the hunk. Never hide code across it.
                if (delimiter || regexLiteral) return undefined;
                result += char;
                lineComment = false;
                previous = '';
                continue;
            }
            if (lineComment) {
                result += ' ';
                continue;
            }
            if (blockComment) {
                if (char === '*' && next === '/') {
                    result += '  ';
                    index++;
                    blockComment = false;
                } else result += ' ';
                continue;
            }
            if (delimiter || regexLiteral) {
                if (
                    pythonInterpolation &&
                    (char === '{' || char === '}') &&
                    next === char
                ) {
                    result += '  ';
                    index++;
                    continue;
                }
                if (
                    (delimiter === '`' &&
                        templateExpressions &&
                        char === '$' &&
                        next === '{') ||
                    (pythonInterpolation && char === '{')
                ) {
                    result += pythonInterpolation ? '{' : '${';
                    if (!pythonInterpolation) index++;
                    interpolations.push({
                        depth: 0,
                        delimiter,
                        python: pythonInterpolation,
                    });
                    delimiter = '';
                    pythonInterpolation = false;
                    previous = '{';
                    continue;
                }
                if (
                    char === '\\' &&
                    next !== undefined &&
                    next !== '\n' &&
                    !(pythonInterpolation && (next === '{' || next === '}')) &&
                    !(delimiter === '`' && /\.go$/i.test(filename))
                ) {
                    result += '  ';
                    index++;
                    continue;
                }
                if (delimiter && source.startsWith(delimiter, index)) {
                    result += ' '.repeat(delimiter.length);
                    index += delimiter.length - 1;
                    delimiter = '';
                    pythonInterpolation = false;
                    previous = 'v';
                } else {
                    if (regexLiteral) {
                        if (char === '[') regexClass = true;
                        if (char === ']') regexClass = false;
                        if (char === '/' && !regexClass) {
                            regexLiteral = false;
                            previous = 'v';
                        }
                    }
                    result += ' ';
                }
                continue;
            }
            if (interpolations.length && (char === '{' || char === '}')) {
                const current = interpolations[interpolations.length - 1];
                if (char === '{') current.depth++;
                else if (current.depth === 0) {
                    interpolations.pop();
                    delimiter = current.delimiter;
                    pythonInterpolation = current.python;
                } else current.depth--;
            }
            if (
                (!hashComments && char === '/' && next === '/') ||
                (char === '#' && hashComments)
            ) {
                lineComment = true;
                result += ' ';
                continue;
            }
            if (!hashComments && char === '/' && next === '*') {
                blockComment = true;
                result += '  ';
                index++;
                continue;
            }
            if (char === '"' || char === "'" || char === '`') {
                const prefix =
                    source.slice(0, index).match(/[\p{ID_Continue}]+$/u)?.[0] ??
                    '';
                const knownPrefix = hashComments
                    ? /^(?:[rubft]|br|rb|fr|rf|tr|rt)$/i.test(prefix)
                    : /\.rs$/i.test(filename) &&
                      (prefix === 'b' || (prefix === 'c' && char === '"'));
                if (
                    !knownPrefix &&
                    char !== '`' &&
                    /\p{ID_Continue}/u.test(source[index - 1] ?? '') &&
                    /\p{ID_Start}/u.test(next ?? '')
                )
                    return undefined;
                if (knownPrefix)
                    result =
                        result.slice(0, -prefix.length) +
                        ' '.repeat(prefix.length);
                delimiter = source.startsWith(char.repeat(3), index)
                    ? char.repeat(3)
                    : char;
                pythonInterpolation =
                    hashComments && knownPrefix && /[ft]/i.test(prefix);
                result += ' '.repeat(delimiter.length);
                index += delimiter.length - 1;
                continue;
            }
            if (
                char === '/' &&
                templateExpressions &&
                (!previous || /[=(,:;!&|?{\[>]/.test(previous))
            ) {
                regexLiteral = true;
                regexClass = false;
                result += ' ';
                continue;
            }
            result += char;
            if (char.trim()) previous = char;
        }
        return delimiter ||
            blockComment ||
            regexLiteral ||
            interpolations.length
            ? undefined
            : addedOnly(result);
    });
    return fragments.some((fragment) => fragment === undefined)
        ? undefined
        : fragments.join('\n');
}
