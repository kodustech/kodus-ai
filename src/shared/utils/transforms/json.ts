import * as JSON5 from 'json5';

const transformToValidJSON = (input: string): string => {
    // Replaces unescaped single quotes with double quotes
    return input.replace(/(?<!\\)'/g, '"');
};

const tryParseJSONObject = (payload: any) => {
    try {
        const cleanedPayload = payload
            .replace(/\\\\n/g, '\\n') // Transform '\\\\n' into '\n'
            .replace(/\\'/g, "'") // Fix escaped single quotes
            .replace(/(\r\n|\n|\r)/gm, '') // Remove newlines outside of strings
            .replace(/\\\\"/g, '\\"');

        const parsedData: any = tryParseJSONObjectWithFallback(cleanedPayload);

        if (
            parsedData &&
            (typeof parsedData === 'object' || Array.isArray(parsedData))
        ) {
            return parsedData;
        }

        return null;
    } catch (err) {
        console.log('Error handling the return object from the LLM', err);
        return null;
    }
};

const tryParseJSONObjectWithFallback = (payload: any) => {
    try {
        return JSON5.parse(payload);
    } catch (err) {
        try {
            return JSON.parse(payload);
        } catch (err2) {
            try {
                const noCodeBlocks = stripCodeBlocks(payload);
                const cleanedPayload = noCodeBlocks
                    .replace(/\\n/g, '') // Remove newline characters
                    .replace(/\\/g, '') // Remove backslashes (escape characters)
                    .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments (/* comment */)
                    .replace(/<[^>]*>/g, '') // Remove HTML tags (e.g., <tag>)
                    .trim();

                return JSON.parse(cleanedPayload);
            } catch (err3) {
                console.log(
                    'Error handling the return object from OpenAI',
                    err3,
                );
                return null;
            }
        }
    }
};

const stripCodeBlocks = (text: string) => {
    // Remove quotes at the beginning and end if they exist
    const cleanText = text.replace(/^['"]|['"]$/g, '');

    // Extract the content between ```json and ```
    const match = cleanText.match(/```json({[\s\S]*?})```/);
    if (match && match[1]) {
        return match[1];
    }

    return cleanText;
};

export { transformToValidJSON, tryParseJSONObject };
