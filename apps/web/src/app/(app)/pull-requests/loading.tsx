import { ReviewsPageSkeleton } from "@components/system/page-skeletons";
import { ReviewsSourceTabs } from "@components/system/reviews-source-tabs";

export default function Loading() {
    return <ReviewsPageSkeleton tabs={<ReviewsSourceTabs />} />;
}
