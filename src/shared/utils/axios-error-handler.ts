import axios from 'axios';

export type ErrorResponse = {
    status: number;
    userMessage: string;
    developerMessage?: string;
};

export class AxiosErrorHandler {
    public static createErrorResponse(error: unknown): ErrorResponse {
        if (axios.isAxiosError(error) && error.response) {
            const { status, data } = error.response;
            let userMessage = 'An error occurred with your request.';

            if (data.errorMessages && data.errorMessages.length > 0) {
                // Ensures each error is a string before concatenating
                const errorMessage = data.errorMessages
                    .map((msg) => (typeof msg === 'string' ? msg : ''))
                    .join('. ');
                userMessage =
                    errorMessage + (errorMessage.endsWith('.') ? '' : '.');
            } else if (data.errors && Object.keys(data.errors).length > 0) {
                // Concatenates messages from 'errors' and ensures they end with a period
                const errorsMessages = Object.values(data.errors)
                    .map((err) => (typeof err === 'string' ? err : ''))
                    .join('. ');
                userMessage =
                    errorsMessages + (errorsMessages.endsWith('.') ? '' : '.');
            }

            return {
                status,
                userMessage,
                developerMessage: data.message || 'API-specific error.',
            };
        } else {
            return {
                status: 500,
                userMessage: 'Internal server error.',
                developerMessage: 'Unexpected error.',
            };
        }
    }
}
