"use client";

import { Link } from "@components/ui/link";
import { Controller, useFormContext } from "react-hook-form";
import { addSearchParamsToUrl } from "src/core/utils/url";

import { CodeReviewFormType, FormattedConfigLevel } from "../../../_types";
import {
    useCodeReviewRouteParams,
    useCurrentConfigLevel,
} from "../../../../_hooks";
import { SettingToggleRow } from "./setting-toggle-row";

export const KodusConfigFileOverridesWebPreferences = () => {
    const form = useFormContext<CodeReviewFormType>();
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const currentLevel = useCurrentConfigLevel();

    const kodyRulesUrl = addSearchParamsToUrl(
        `/settings/code-review/${repositoryId}/kody-rules`,
        { directoryId },
    );

    if (currentLevel === FormattedConfigLevel.GLOBAL) {
        return null;
    }

    return (
        <Controller
            name="kodusConfigFileOverridesWebPreferences.value"
            control={form.control}
            render={({ field }) => (
                <SettingToggleRow
                    id={field.name}
                    title="Prefer kodus-config.yml settings"
                    description={`Use settings from the config file when it exists in this ${currentLevel === FormattedConfigLevel.REPOSITORY ? "repository" : "directory"}. This preference is configured only here.`}
                    fieldName="kodusConfigFileOverridesWebPreferences"
                    checked={field.value}
                    disabled={field.disabled}
                    onCheckedChange={field.onChange}
                    detail={
                        <p className="text-text-tertiary mt-1 text-xs">
                            <Link
                                href={kodyRulesUrl}
                                className="text-xs underline-offset-3">
                                Kody Rules
                            </Link>{" "}
                            are always configured in the web interface.
                        </p>
                    }
                />
            )}
        />
    );
};
