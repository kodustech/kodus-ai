import { formatDistanceToNowStrict } from "date-fns";

/** "3 min ago", with the exact UTC time on hover. */
export const RelativeTime = ({ at }: { at: string | undefined }) => {
    if (!at || Number.isNaN(Date.parse(at))) return <span>—</span>;
    const date = new Date(at);
    return (
        <time dateTime={at} title={date.toISOString()}>
            {formatDistanceToNowStrict(date, { addSuffix: true })}
        </time>
    );
};
