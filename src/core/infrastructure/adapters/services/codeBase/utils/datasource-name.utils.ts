import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

export interface RepositoryInfo {
    id: string;
    name: string;
}

function normalizeText(text: string): string {
    if (!text) return '';

    return (
        text
            .toLowerCase()
            // 1. First converts to lowercase and normalizes spaces
            .replace(/\s+/g, '-')
            // 2. Replaces special characters with hyphens
            .replace(/[^a-z0-9]+/g, '-')
            // 3. Adds a hyphen before numbers if not present
            .replace(/([a-z])(\d+)/g, '$1-$2')
            // 4. Removes duplicate hyphens
            .replace(/-+/g, '-')
            // 5. Removes hyphens from the start and end
            .replace(/^-+|-+$/g, '')
    );
}

function normalizeDataSourceName(name: string): string {
    if (!name) return '';

    // Split by : to handle each part
    const parts = name.split(':');

    return parts
        .map((part, index) => {
            // For IDs (positions 1 and 3), keep them exactly as they are
            if (index === 1 || index === 3) {
                return part;
            }
            return normalizeText(part);
        })
        .join(':');
}

export function generateDataSourceName(
    organizationAndTeamData: OrganizationAndTeamData,
    repository: RepositoryInfo,
    branch: string,
): string {
    const name = `${organizationAndTeamData?.organizationName || ''}:${organizationAndTeamData?.organizationId || ''}:${repository?.name || ''}:${repository?.id || ''}:${branch || ''}`;
    return normalizeDataSourceName(name);
}

export function parseDataSourceName(dataSourceName: string): {
    organization: string;
    organizationId: string;
    repositoryName: string;
    repositoryId: string;
    branch: string;
} {
    const [organization, organizationId, repositoryName, repositoryId, branch] =
        dataSourceName.split(':');
    return {
        organization,
        organizationId,
        repositoryName,
        repositoryId,
        branch,
    };
}
