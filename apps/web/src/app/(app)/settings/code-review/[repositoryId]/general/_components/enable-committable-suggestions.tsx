import { Badge } from "@components/ui/badge";
import { useSuspenseGetConnections } from "@services/setup/hooks";
import { Controller, useFormContext } from "react-hook-form";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { PlatformType } from "src/core/types";
import { safeArray } from "src/core/utils/safe-array";

import type { CodeReviewFormType } from "../../../_types";
import { SettingToggleRow } from "./setting-toggle-row";

const hasGithubConnection = (
    connections: ReturnType<typeof useSuspenseGetConnections>,
): boolean => {
    return safeArray(connections)
        .filter((c) => c.category === "CODE_MANAGEMENT" && c.hasConnection)
        .some((connection) => connection.platformName === PlatformType.GITHUB);
};

export const EnableCommittableSuggestions = () => {
    const form = useFormContext<CodeReviewFormType>();
    const { teamId } = useSelectedTeamId();
    const connections = useSuspenseGetConnections(teamId);
    const isCodeManagementGithub = hasGithubConnection(connections);

    return (
        <Controller
            name="enableCommittableSuggestions.value"
            disabled={!isCodeManagementGithub}
            control={form.control}
            render={({ field }) => (
                <SettingToggleRow
                    id={field.name}
                    title="Committable suggestions"
                    description="Let Kody suggest code that can be applied directly as a commit. Available on GitHub."
                    fieldName="enableCommittableSuggestions"
                    checked={field.value}
                    disabled={field.disabled}
                    onCheckedChange={field.onChange}
                    badge={
                        <Badge variant="secondary" size="xs">
                            Alpha
                        </Badge>
                    }
                    detail={
                        field.value && (
                            <p className="text-error-foreground mt-1 text-xs font-medium">
                                Experimental: suggestions may produce unexpected
                                results.
                            </p>
                        )
                    }
                />
            )}
        />
    );
};
