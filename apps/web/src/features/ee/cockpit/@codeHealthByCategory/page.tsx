import { Card, CardContent, CardHeader, CardTitle } from "@components/ui/card";
import { capitalize, pluralize } from "src/core/utils/string";
import { getCodeHealthSuggestionsByCategory } from "src/features/ee/cockpit/_services/analytics/code-health/fetch";

import { CockpitNoDataPlaceholder } from "../_components/no-data-placeholder";
import { extractApiData } from "../_helpers/api-data-extractor";
import { getSelectedDateRange } from "../_helpers/get-selected-date-range";

export default async function CodeHealthByCategory() {
    const selectedDateRange = await getSelectedDateRange();

    const response = await getCodeHealthSuggestionsByCategory({
        startDate: selectedDateRange.startDate,
        endDate: selectedDateRange.endDate,
    });

    const data = extractApiData(response);

    if (!data || data.length === 0) {
        return <CockpitNoDataPlaceholder mini className="col-span-3 mt-0" />;
    }

    return (
        <>
            {data.map((d: any) => {
                const categoryName = d.category
                    .split("_")
                    .map(capitalize)
                    .join(" ");

                return (
                    <Card key={d.category}>
                        <CardHeader>
                            <CardTitle className="text-sm">
                                {categoryName}
                            </CardTitle>
                        </CardHeader>

                        <CardContent className="flex items-end gap-1">
                            <div className="text-3xl leading-5 font-bold">
                                {d.count}
                            </div>
                            <span className="text-text-secondary ml-0.5 text-sm leading-[0.8]">
                                {pluralize(d.count, {
                                    plural: "issues",
                                    singular: "issue",
                                })}
                            </span>
                        </CardContent>
                    </Card>
                );
            })}
        </>
    );
}
