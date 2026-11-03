/**
 * Enrichment, deterministic half (#1821). The finder emits five lean fields;
 * what the comment needs and no model has to decide is restored here from the
 * file at the PR head: the cited code and the fence language. The title, the
 * fix and the severity come from model calls after this.
 */
import { SUPPORTED_LANGUAGES } from '@libs/code-review/domain/contracts/SupportedLanguages';

export type AnchorStatus = 'ok' | 'file-missing' | 'range-invalid';

export type DeterministicEnrichment = {
    /** Exactly lines relevantLinesStart..relevantLinesEnd of the head file. */
    existingCode: string;
    /** Markdown fence language; '' when the extension is unknown. */
    language: string;
    anchorStatus: AnchorStatus;
};

const EXTRA_FENCES: Record<string, string> = {
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.gjs': 'javascript',
    '.hbs': 'handlebars',
    '.erb': 'erb',
    '.css': 'css',
    '.scss': 'scss',
    '.html': 'html',
    '.json': 'json',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.sql': 'sql',
    '.sh': 'bash',
    '.md': 'markdown',
    '.kt': 'kotlin',
    '.swift': 'swift',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.proto': 'protobuf',
    '.xml': 'xml',
    '.ftl': 'ftl',
};

export function languageFromPath(path: string | undefined): string {
    const name = (path ?? '').split('/').pop() ?? '';
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return '';
    const ext = name.slice(dot).toLowerCase();
    const supported = Object.values(SUPPORTED_LANGUAGES).find((l) =>
        l.extensions.includes(ext),
    );
    return supported?.name ?? EXTRA_FENCES[ext] ?? '';
}

/**
 * `headFileContent` is the file at the PR head, or null when it does not
 * exist there. A range past the end of the file is cut at the last line; one
 * that starts past it, or ends before it starts, is invalid and yields no code.
 */
export function enrichDeterministic(
    finding: {
        relevantFile?: string;
        relevantLinesStart?: number;
        relevantLinesEnd?: number;
    },
    headFileContent: string | null,
): DeterministicEnrichment {
    const language = languageFromPath(finding.relevantFile);
    if (headFileContent == null) {
        return { existingCode: '', language, anchorStatus: 'file-missing' };
    }
    const lines = headFileContent.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const start = finding.relevantLinesStart;
    const end = finding.relevantLinesEnd ?? start;
    if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 1 ||
        end < start ||
        start > lines.length
    ) {
        return { existingCode: '', language, anchorStatus: 'range-invalid' };
    }
    return {
        existingCode: lines
            .slice(start - 1, Math.min(end, lines.length))
            .join('\n'),
        language,
        anchorStatus: 'ok',
    };
}
