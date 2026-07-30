import { CardHeader, CardTitle } from "@components/ui/card";

export const DeployFrequencyAnalyticsHeader = ({
    children,
}: {
    children?: React.JSX.Element;
}) => {
    return (
        <CardHeader>
            <div className="flex justify-between gap-4">
                <CardTitle className="text-text-secondary text-xs font-semibold">Deploy Frequency</CardTitle>
                {children}
            </div>
        </CardHeader>
    );
};
