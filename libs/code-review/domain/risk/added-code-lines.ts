/** Undefined fragments cannot certify test evidence or a low-risk control-flow check. */
export function addedCodeLines(
    patch: string,
    filename: string,
): string | undefined {
    const hashComments = filename.toLowerCase().endsWith('.py');
    const templateExpressions = /\.[cm]?[jt]sx?$/i.test(filename);
    const fragments = patch.split(/^@@.*@@.*$/m).map((hunk) => {
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
            if (interpolationDepth.length && (char === '{' || char === '}')) {
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
                if (
                    char !== '`' &&
                    /\p{ID_Continue}/u.test(source[index - 1] ?? '') &&
                    /\p{ID_Start}/u.test(next ?? '')
                )
                    return undefined;
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
        return delimiter ||
            blockComment ||
            regexLiteral ||
            interpolationDepth.length
            ? undefined
            : addedOnly(result);
    });
    return fragments.some((fragment) => fragment === undefined)
        ? undefined
        : fragments.join('\n');
}
