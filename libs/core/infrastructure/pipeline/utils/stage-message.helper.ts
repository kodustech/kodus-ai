import { PipelineReason } from '../interfaces/pipeline-reason.interface';

export class StageMessageHelper {
    static skippedWithReason(
        reason: PipelineReason,
        techDetail?: string,
    ): string {
        let result = reason.message;

        if (reason.action) {
            result += ` — ${reason.action}`;
        }

        if (techDetail) {
            result += ` (${techDetail})`;
        }

        return result;
    }

    static skipped(userMessage: string, technicalReason?: string): string {
        if (!technicalReason) {
            return userMessage;
        }
        return `${userMessage} (Tech: ${technicalReason})`;
    }

    static error(userMessage: string, error?: unknown): string {
        if (!error) {
            return userMessage;
        }

        let technicalDetails: string;
        if (error instanceof Error) {
            technicalDetails = error.message;
        } else if (typeof error === 'string') {
            technicalDetails = error;
        } else {
            try {
                technicalDetails = JSON.stringify(error);
            } catch {
                technicalDetails = String(error);
            }
        }

        return `${userMessage} (Error: ${technicalDetails})`;
    }
}
