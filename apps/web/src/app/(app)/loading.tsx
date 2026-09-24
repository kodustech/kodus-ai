import { RouteSkeleton } from "./_components/route-skeleton";

// Nearest boundary for every section: the moment a navigation starts, the
// content area shows the target page's skeleton while that section's layout
// (settings, cockpit, organization…) is still fetching on the server.
export default RouteSkeleton;
