import { CardContent } from "@components/ui/card";
import { getDeveloperActivity } from "src/features/ee/cockpit/_services/analytics/productivity/fetch";

import { CockpitNoDataPlaceholder } from "../_components/no-data-placeholder";
import { extractApiData } from "../_helpers/api-data-extractor";
import { getSelectedDateRange } from "../_helpers/get-selected-date-range";
import { TableNoSSR } from "./_components/table.no-ssr";

export default async function TeamActivityChart() {
    const selectedDateRange = await getSelectedDateRange();

    const response = await getDeveloperActivity({
        startDate: selectedDateRange.startDate,
        endDate: selectedDateRange.endDate,
    });

    const data = extractApiData(response);

    if (!data || data.length === 0) {
        return <CockpitNoDataPlaceholder className="h-60" />;
    }

    const groupedByDeveloper = data.reduce(
        (acc: any, item: any) => {
            const { developer, ...rest } = item;
            const existingDeveloper = acc[developer];

            if (existingDeveloper) {
                existingDeveloper.push(rest);
                return acc;
            }

            acc[developer] = [rest];
            return acc;
        },
        {} as Record<string, Array<{ date: string; prCount: number }>>,
    );

    return (
        <>
            <CardContent className="flex items-center justify-center px-0 pb-0">
                <TableNoSSR
                    startDate={selectedDateRange.startDate}
                    endDate={selectedDateRange.endDate}
                    data={Object.entries(groupedByDeveloper)}
                />
            </CardContent>
        </>
    );
}
