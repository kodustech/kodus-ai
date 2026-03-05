import { CardContent } from "@components/ui/card";

import { extractApiData } from "../_helpers/api-data-extractor";
import { getKodySuggestionsAnalytics } from "../_services/analytics/productivity/fetch";
import { Chart } from "./_components/chart";
import NoData from "./_components/no-data";

export default async function KodySuggestions() {
    const response = await getKodySuggestionsAnalytics();
    const data = extractApiData(response);

    if (data.suggestionsSent === 0 && data.suggestionsImplemented === 0) {
        return <NoData />;
    }

    return (
        <CardContent>
            <Chart data={data} />
        </CardContent>
    );
}
