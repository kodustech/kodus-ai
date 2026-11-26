import { SvgAzureRepos } from "@components/ui/icons/SvgAzureRepos";
import { SvgBitbucket } from "@components/ui/icons/SvgBitbucket";
import { SvgForgejo } from "@components/ui/icons/SvgForgejo";
import { SvgGithub } from "@components/ui/icons/SvgGithub";
import { SvgGitlab } from "@components/ui/icons/SvgGitlab";
import { INTEGRATIONS_KEY } from "@enums";

export const CODE_MANAGEMENT_PLATFORMS = {
    [INTEGRATIONS_KEY.GITHUB]: {
        svg: SvgGithub,
        platformName: "Github",
    },
    [INTEGRATIONS_KEY.GITLAB]: {
        svg: SvgGitlab,
        platformName: "Gitlab",
    },
    [INTEGRATIONS_KEY.BITBUCKET]: {
        svg: SvgBitbucket,
        platformName: "Bitbucket",
    },
    [INTEGRATIONS_KEY.AZURE_REPOS]: {
        svg: SvgAzureRepos,
        platformName: "Azure Repos",
    },
    [INTEGRATIONS_KEY.FORGEJO]: {
        svg: SvgForgejo,
        platformName: "Forgejo",
    },
} as const satisfies Partial<
    Record<
        Lowercase<keyof typeof INTEGRATIONS_KEY>,
        {
            svg: React.ComponentType;
            platformName: string;
        }
    >
>;

type LabelledConnection = {
    connectionId?: string;
    connectionName?: string | null;
    platformName: string;
};

/**
 * How a Git connection is shown: its name, else its provider's readable
 * name, numbered when the workspace has more than one unnamed connection of
 * that provider. A generated label never repeats a connection's own name.
 */
export const connectionLabel = (
    connection: LabelledConnection,
    connections: LabelledConnection[] = [connection],
): string => {
    const named = connection.connectionName?.trim();
    if (named) return named;
    const readable =
        CODE_MANAGEMENT_PLATFORMS[
            connection.platformName.toLowerCase() as keyof typeof CODE_MANAGEMENT_PLATFORMS
        ]?.platformName ?? connection.platformName;
    const taken = new Set(
        connections
            .map((other) => other.connectionName?.trim().toLowerCase())
            .filter((name): name is string => !!name),
    );
    const unnamedAlike = connections.filter(
        (other) =>
            !other.connectionName?.trim() &&
            other.platformName === connection.platformName,
    );
    if (unnamedAlike.length < 2 && !taken.has(readable.toLowerCase())) {
        return readable;
    }
    const position = Math.max(
        0,
        unnamedAlike.findIndex(
            (other) =>
                other === connection ||
                (!!other.connectionId &&
                    other.connectionId === connection.connectionId),
        ),
    );
    // The (position + 1)th number no named connection already uses.
    let label: string = readable;
    for (let n = 1, free = 0; free <= position; n++) {
        label = `${readable} ${n}`;
        if (!taken.has(label.toLowerCase())) free++;
    }
    return label;
};
