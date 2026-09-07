import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "@components/ui/breadcrumb";
import { addSearchParamsToUrl } from "src/core/utils/url";

import { useCodeReviewConfig } from "../../_components/context";
import { KodusConfigFileStatusBadge } from "../../_components/kodus-config-file-status";
import { useSettingsShellMode } from "../../_components/shell-mode-context";
import { useCodeReviewRouteParams } from "../../_hooks";

export const CodeReviewPagesBreadcrumb = (props: { pageName: string }) => {
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const config = useCodeReviewConfig();
    const shellMode = useSettingsShellMode();

    // In the tabs shell the header already names the scope and the page
    // (and carries the kodus-config.yml badge), so the breadcrumb would be
    // the same location stated a third time.
    if (shellMode === "tabs") return null;

    const url = addSearchParamsToUrl(
        `/settings/code-review/${repositoryId}/general`,
        { directoryId },
    );

    return (
        // Every code review settings page renders this breadcrumb, so the
        // kodus-config.yml indicator rides along with it and shows up on all
        // of them without each page opting in.
        <div className="flex flex-wrap items-center gap-3">
            <Breadcrumb>
                <BreadcrumbList>
                    <BreadcrumbItem>
                        <BreadcrumbLink href={url}>
                            {config?.displayName}
                        </BreadcrumbLink>
                    </BreadcrumbItem>

                    <BreadcrumbSeparator />

                    <BreadcrumbItem>
                        <BreadcrumbPage>{props.pageName}</BreadcrumbPage>
                    </BreadcrumbItem>
                </BreadcrumbList>
            </Breadcrumb>

            <KodusConfigFileStatusBadge />
        </div>
    );
};
