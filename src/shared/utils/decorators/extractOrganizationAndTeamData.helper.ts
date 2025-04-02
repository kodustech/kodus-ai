import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

export function extractOrganizationAndTeamData(
    args: any[],
): OrganizationAndTeamData | undefined {
    const foundArg = args.find(
        (arg) =>
            arg &&
            typeof arg === 'object' &&
            ('organizationId' in arg ||
                'teamId' in arg ||
                (arg.organizationAndTeamData &&
                    typeof arg.organizationAndTeamData === 'object' &&
                    ('organizationId' in arg.organizationAndTeamData ||
                        'teamId' in arg.organizationAndTeamData))),
    );

    if (!foundArg) {
        return undefined;
    }

    const result: OrganizationAndTeamData = {};

    // Check if the IDs are in the main object
    if ('organizationId' in foundArg) {
        result.organizationId = foundArg.organizationId;
    }
    if ('teamId' in foundArg) {
        result.teamId = foundArg.teamId;
    }

    // Check if the IDs are inside organizationAndTeamData
    if (foundArg.organizationAndTeamData) {
        if ('organizationId' in foundArg.organizationAndTeamData) {
            result.organizationId =
                foundArg.organizationAndTeamData.organizationId;
        }
        if ('teamId' in foundArg.organizationAndTeamData) {
            result.teamId = foundArg.organizationAndTeamData.teamId;
        }
    }

    return Object.keys(result).length > 0 ? result : undefined;
}
