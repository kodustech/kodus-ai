import { jsonFormatter } from '../formatters/json.js';
import { markdownFormatter } from '../formatters/markdown.js';
import { promptFormatter } from '../formatters/prompt.js';
import { terminalFormatter } from '../formatters/terminal.js';
import type { OutputFormat } from '../types/cli.js';
import type { ReviewResult } from '../types/review.js';

export function formatReviewOutput(
    result: ReviewResult,
    format: OutputFormat,
): string {
    switch (format) {
        case 'json':
            return jsonFormatter.format(result);
        case 'markdown':
            return markdownFormatter.format(result);
        case 'prompt':
            return promptFormatter.format(result);
        case 'terminal':
        default:
            return terminalFormatter.format(result);
    }
}
