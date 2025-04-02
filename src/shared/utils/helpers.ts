import { Repository } from '@/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { IOrganizationArtifact } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifact.interface';
import * as moment from 'moment-timezone';

export function extractRepoNames(
    urls: { http_url: string }[] | string[],
): string[] {
    if (!urls) return [];

    return urls.map((url: any) => {
        const parts =
            typeof url === 'string'
                ? url?.split('/')
                : url?.http_url?.split('/');
        return parts[parts?.length - 1];
    });
}

export function extractRepoName(repoName: string): string {
    if (!repoName) return '';

    const parts = repoName.split('/');

    return parts[parts.length - 1].trim();
}

export function extractRepoData(
    repositories: any[],
    repoName: string,
    platform?: string,
): Repository {
    return repositories
        ?.filter((repository) => repository?.name === repoName)
        ?.map((repository) => ({
            id: repository?.id,
            name: repository?.name,
            fullName: `${repository?.organizationName}/${repository?.name}`,
            language: repository?.language,
            defaultBranch: repository?.default_branch,
            platform: platform || repository?.platform,
            organizationName: repository?.organizationName,
        }))[0];
}

export function hoursDiff(initialDate: Date, finalDate: Date) {
    // Converting the date strings to Date objects
    const initialDateObj = new Date(initialDate);
    const finalDateObj = new Date(finalDate);

    // Calculating the difference in milliseconds
    const diffMilliseconds = finalDateObj.getTime() - initialDateObj.getTime();

    // Converting the difference to hours
    return diffMilliseconds / (1000 * 60 * 60);
}

/**
 * Generates the start and end date of the current week. Sunday to Sunday
 *
 * @return {Object} an object containing the start and end date of the current week
 */
export function getWeekDate() {
    const today = new Date();
    const dayOfWeek = today.getDay();

    const daysSinceSunday = dayOfWeek === 0 ? 7 : dayOfWeek;

    const previousSunday = new Date(today);
    previousSunday.setDate(today.getDate() - daysSinceSunday);
    previousSunday.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    yesterday.setHours(23, 59, 59, 999);

    const startDate = moment(previousSunday).format('YYYY-MM-DD HH:mm');
    const endDate = moment(yesterday).format('YYYY-MM-DD HH:mm');

    return { startDate, endDate };
}

export function getPreviousWeekRange() {
    const today = new Date();

    const endDate = new Date(today);

    const startDate = new Date(today);
    startDate.setDate(today.getDate() - 7);

    return {
        startDate: moment(startDate).format('YYYY-MM-DD HH:mm'),
        endDate: moment(endDate).format('YYYY-MM-DD HH:mm'),
    };
}

export function getLast24hoursRange() {
    const today = new Date();
    const endDate = new Date(today);

    const startDate = new Date(today);
    startDate.setDate(today.getDate() - 1);

    return {
        startDate: moment(startDate).format('YYYY-MM-DD HH:mm'),
        endDate: moment(endDate).format('YYYY-MM-DD HH:mm'),
    };
}

/**
 * Filters the provided `rawData` based on the specified `columns` and `filterColumns`.
 *
 * @param {any[]} rawData - The raw data to filter.
 * @param {any[]} columns - The columns to use as a filter.
 * @param {any[]} filterColumns - The columns to filter by ['todo', 'wip', 'done'].
 * @return {any[]} The filtered data.
 */
export function filterByColumn(rawData, columns, filterColumns) {
    const columnMap = columns.reduce((acc, column) => {
        acc[column.id] = column.column;
        return acc;
    }, {});

    return rawData.filter((data) => {
        const columnType = columnMap[data.columnId];

        return filterColumns.includes(columnType);
    });
}

export function parseJson(value: string) {
    try {
        return JSON.parse(value);
    } catch (error) {
        return {};
    }
}

export function mergeConfig<T>(defaultConfig: T, userConfig?: Partial<T>): T {
    return { ...defaultConfig, ...userConfig };
}

/**
 * Extracts the organization ID from the given parameters.
 *
 * @param {any} params - The input parameters object.
 * @return {string} The extracted organization ID.
 */
export function extractOrganizationId(params: any): string {
    return (
        params?.organizationAndTeamData?.organizationId || params.organizationId
    );
}

export function extractOrganizationAndTeamData(
    params: any,
): OrganizationAndTeamData {
    return (
        params?.organizationAndTeamData || {
            organizationId: params?.organizationId,
            teamId: params?.teamId,
        }
    );
}

export function shouldProcessNotBugItems(
    workItemType: string,
    bugTypes: any,
): boolean {
    const lowerCaseType = workItemType.toLowerCase();
    // List of work item types that should be ignored
    const skipTypes = [
        'error',
        ...bugTypes.map((bugType) => bugType.name.toLowerCase()),
    ];

    return skipTypes.includes(lowerCaseType);
}

export function checkArtifactActiveForTeam(
    organizationTeamArtifactsFromParameters: any,
    organizationArtifact: IOrganizationArtifact,
) {
    try {
        const parameter = organizationTeamArtifactsFromParameters?.find(
            (ta) => ta.name === organizationArtifact.name,
        );

        return parameter ? parameter.status : false;
    } catch (error) {
        console.log(error);
    }
}

export function sanitizeString(str) {
    if (!str) {
        return str;
    }

    return str.replace(/["\\]/g, '');
}

export async function sleep(ms = 1000) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

export const generateRandomOrgName = (name: string): string => {
    let organizationName = `${name}-${randomString(16)}`;

    organizationName = organizationName?.replace(/[^\w\-]/gi, '');
    organizationName = organizationName?.substring(0, 50);

    return organizationName;
};

export const randomString = (length: number) => {
    const charset =
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    return Array.from(crypto.getRandomValues(new Uint32Array(length)))
        .map((x) => charset[x % charset.length])
        .join('');
};

const retryWithBackoff = async (
    fn: Function,
    retries: number = 4,
    delay: number = 1000,
): Promise<any> => {
    try {
        return await fn();
    } catch (error) {
        if (retries === 0 || !error.response || error.response.status !== 429) {
            throw error;
        }
        // Calculate the exponential delay
        const backoffDelay = delay * Math.pow(2, 5 - retries);
        console.log(`Retrying in ${backoffDelay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, backoffDelay));
        return retryWithBackoff(fn, retries - 1, delay);
    }
};

const parseHunksGithub = (patch: string) => {
    const lines = patch.split('\n');
    let newHunk = '';
    let oldHunk = '';

    lines.forEach((line) => {
        if (line.startsWith('@@')) {
            // Hunk header, usually like @@ -12,7 +12,7 @@
            // Defines where the old and new code blocks start
            newHunk += line + '\n';
            oldHunk += line + '\n';
        } else if (line.startsWith('+')) {
            // Line added to the code (new hunk)
            newHunk += line + '\n';
        } else if (line.startsWith('-')) {
            // Line removed from the code (old hunk)
            oldHunk += line + '\n';
        } else {
            // Unchanged line (appears in both hunks for context)
            newHunk += line + '\n';
            oldHunk += line + '\n';
        }
    });

    return { newHunk, oldHunk };
};

export const cleanHumanMessages = (input) => {
    // Copies the original data to avoid mutations in the object
    const data = JSON.parse(JSON.stringify(input));

    // Helper function to clean the content of the messages
    const cleanContent = (content) => {
        return content
            .replace(/\\n/g, ' ') // Replaces "\n" with spaces
            .replace(
                /Contextual information.*?:.*?\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g,
                '',
            ) // Removes 'Contextual information' with date/time
            .replace(/###Data Analyst Tool Response[\s\S]*?### Files/g, '') // Removes the entire block between '###Data Analyst Tool Response' and '### Files'
            .replace(
                /Error executing ConversationCodeBaseTool\. Please try again\./g,
                '',
            ) // Removes error messages
            .replace(/Code Base data:.*$/s, '') // Removes everything after "Code Base data:"
            .replace(/\s+/g, ' ') // Replaces multiple spaces with a single one
            .replace(/Pull Requests:.*$/, '') // Removes everything after "Pull Requests:"
            .trim(); // Trims spaces at the beginning and end
    };

    // Iterates over all messages and applies the cleaning
    data._messages = data._messages.map((message) => {
        if (message.type === 'human' && message.data?.content) {
            // Cleans the 'content' field using the helper function
            message.data.content = cleanContent(message.data.content);
        }
        return message;
    });

    return data;
};

export { retryWithBackoff, parseHunksGithub };
