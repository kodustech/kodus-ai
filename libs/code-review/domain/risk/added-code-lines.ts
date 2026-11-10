/** Mask known comments and literals before checking lexical signals on added lines. */
export function addedCodeLines(patch: string, filename: string): string {
    const hashComments = filename.toLowerCase().endsWith('.py');
    const templateExpressions = /\.[cm]?[jt]sx?$/i.test(filename);
    return patch
        .split(/^@@.*@@.*$/m)
        .map((hunk) => {
            const lines = hunk
                .split('\n')
                .filter(
                    (line) =>
                        line.startsWith(' ') ||
                        (line.startsWith('+') && !line.startsWith('+++')),
                );
            if (!lines.length) return '';
            const source = lines.map((line) => line.slice(1)).join('\n');
            const addedOnly = (text: string) =>
                text
                    .split('\n')
                    .filter((_, index) => lines[index].startsWith('+'))
                    .join('\n');
            // Keep the conservative signal where a fragment lacks enough
            // language context to distinguish raw literals or Rust lifetimes.
            if (
                (/\.cs$/i.test(filename) && /@\$?"|"{3,}/.test(source)) ||
                (/\.rs$/i.test(filename) &&
                    /\b(?:br|r)#*"|'[A-Za-z_]\w*\b(?!')/.test(source))
            )
                return addedOnly(source);
            let result = '';
            let delimiter = '';
            let blockComment = false;
            let lineComment = false;
            let regexLiteral = false;
            let regexClass = false;
            let previous = '';
            const interpolationDepth: number[] = [];
            for (let index = 0; index < source.length; index++) {
                const char = source[index];
                const next = source[index + 1];
                if (char === '\n') {
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
                        delimiter === '`' &&
                        templateExpressions &&
                        char === '$' &&
                        next === '{'
                    ) {
                        result += '${';
                        index++;
                        delimiter = '';
                        previous = '{';
                        interpolationDepth.push(0);
                        continue;
                    }
                    if (
                        char === '\\' &&
                        next !== undefined &&
                        next !== '\n' &&
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
                if (
                    interpolationDepth.length &&
                    (char === '{' || char === '}')
                ) {
                    const last = interpolationDepth.length - 1;
                    if (char === '{') interpolationDepth[last]++;
                    else if (interpolationDepth[last] === 0) {
                        interpolationDepth.pop();
                        delimiter = '`';
                    } else interpolationDepth[last]--;
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
                    delimiter = source.startsWith(char.repeat(3), index)
                        ? char.repeat(3)
                        : char;
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
            return addedOnly(
                delimiter ||
                    blockComment ||
                    regexLiteral ||
                    interpolationDepth.length
                    ? source
                    : result,
            );
        })
        .join('\n');
}
