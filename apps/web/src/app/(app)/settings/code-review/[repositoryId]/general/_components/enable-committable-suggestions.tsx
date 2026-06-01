import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { CardHeader } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Switch } from "@components/ui/switch";
import { useSuspenseGetConnections } from "@services/setup/hooks";
import { Controller, useFormContext } from "react-hook-form";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { PlatformType } from "src/core/types";
import { safeArray } from "src/core/utils/safe-array";

import { OverrideIndicatorForm } from "../../../_components/override";
import type { CodeReviewFormType } from "../../../_types";

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
        <div className="flex flex-col gap-2">
            <Controller
                name="enableCommittableSuggestions.value"
                disabled={!isCodeManagementGithub}
                control={form.control}
                render={({ field }) => (
                    <Button
                        size="sm"
                        variant="helper"
                        className="w-full"
                        disabled={field.disabled}
                        onClick={() => field.onChange(!field.value)}>
                        <CardHeader className="flex-row items-center justify-between gap-6">
                            <div className="flex flex-col gap-1">
                                <div className="flex flex-row items-center gap-2">
                                    <Heading variant="h3">
                                        Enable committable suggestions
                                    </Heading>

                                    <Badge variant="secondary" size="xs">
                                        Alpha
                                    </Badge>

                                    <OverrideIndicatorForm fieldName="enableCommittableSuggestions" />
                                </div>

                                <p className="text-text-secondary text-sm">
                                    Allows Kody to provide suggestions that can
                                    be applied directly as commits.
                                </p>

                                {field.value && (
                                    <p className="text-error-foreground text-xs font-medium">
                                        Warning: This feature is experimental
                                        and may produce unexpected results.
                                    </p>
                                )}
                            </div>

                            <Switch decorative checked={field.value} />
                        </CardHeader>
                    </Button>
                )}
            />

            <p className="text-text-secondary text-xs">
                Note: This option is only applicable to GitHub.
            </p>
        </div>
    );
};
