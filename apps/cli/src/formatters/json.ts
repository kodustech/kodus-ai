import type { ReviewResult } from '../types/review.js';

class JsonFormatter {
    format(result: ReviewResult): string {
        return JSON.stringify(result, null, 2);
    }
}

export const jsonFormatter = new JsonFormatter();
