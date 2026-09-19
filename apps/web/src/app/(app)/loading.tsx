import { AppPageSkeleton } from "@components/system/page-skeletons";

// Nearest boundary for every section: the moment a navigation starts, the
// content area shows a page-shaped skeleton while the target section's
// layout (settings, cockpit, organization…) is still fetching on the server.
export default AppPageSkeleton;
