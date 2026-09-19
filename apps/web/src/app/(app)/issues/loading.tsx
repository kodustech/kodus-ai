import { IssuesPageSkeleton } from "@components/system/page-skeletons";
import { CockpitNavTabs } from "src/features/ee/cockpit/_components/cockpit-nav-tabs";

export default function Loading() {
    return <IssuesPageSkeleton tabs={<CockpitNavTabs />} />;
}
