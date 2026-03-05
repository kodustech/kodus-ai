/**
 * Utility functions for PR search functionality
 */

export interface SearchParams {
    type: "number" | "title";
    value: string;
}

/**
 * Detects if the search input is a PR number or title search
 * @param input - The search input from user
 * @returns Object with search type and cleaned value
 */
export function detectSearchType(input: string): SearchParams {
    if (!input || input.trim() === "") {
        return { type: "title", value: "" };
    }

    const trimmedInput = input.trim();

    // Check if it's a number (with or without #)
    const numberPattern = /^#?(\d+)$/;
    const match = trimmedInput.match(numberPattern);

    if (match) {
        // It's a number - extract just the digits
        return {
            type: "number",
            value: match[1], // The captured group without #
        };
    }

    // It's a title search
    return {
        type: "title",
        value: trimmedInput,
    };
}

/**
 * Builds search parameters for API call
 * @param input - The search input from user
 * @param teamId - Team ID for the search
 * @param repositoryId - Optional repository ID to filter by
 * @returns API parameters object
 */
export function buildSearchParams(
    input: string,
    teamId: string,
    repositoryId?: string,
): Record<string, unknown> {
    const searchParams = detectSearchType(input);

    const params: Record<string, unknown> = {
        teamId,
    };

    if (repositoryId && repositoryId !== "global") {
        params.repositoryId = repositoryId;
    }

    if (searchParams.value) {
        if (searchParams.type === "number") {
            params.number = searchParams.value;
        } else {
            params.title = searchParams.value;
        }
    }

    return params;
}
