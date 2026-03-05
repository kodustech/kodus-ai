import { CardContent } from "@components/ui/card";
import { extractApiData } from "src/features/ee/cockpit/_helpers/api-data-extractor";
import { getLeadTimeForChange } from "src/features/ee/cockpit/_services/analytics/productivity/fetch";

import { CockpitNoDataPlaceholder } from "../_components/no-data-placeholder";
import { getSelectedDateRange } from "../_helpers/get-selected-date-range";
import { ChartNoSSR } from "./_components/chart.no-ssr";

export default async function LeadTimeForChangeChart() {
    const selectedDateRange = await getSelectedDateRange();

    const response = await getLeadTimeForChange({
        startDate: selectedDateRange.startDate,
        endDate: selectedDateRange.endDate,
    });

    const data = extractApiData(response);

    if (!data || data.length === 0) {
        return <CockpitNoDataPlaceholder />;
    }

    return (
        <CardContent className="flex items-center justify-center">
            <ChartNoSSR data={data} />
        </CardContent>
    );
}
