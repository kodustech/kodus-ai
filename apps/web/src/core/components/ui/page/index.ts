import {
    PAGE_MAX_WIDTH,
    PageContent,
    PageDescription,
    PageFooter,
    PageHeader,
    PageHeaderActions,
    PageRoot,
    PageTitle,
    PageTitleContainer,
    PageWithSidebar,
} from "./components";
import { PageSaveActions } from "./save-actions";

export const Page = {
    Root: PageRoot,
    Title: PageTitle,
    Header: PageHeader,
    TitleContainer: PageTitleContainer,
    Description: PageDescription,
    HeaderActions: PageHeaderActions,
    SaveActions: PageSaveActions,
    Content: PageContent,
    Footer: PageFooter,
    WithSidebar: PageWithSidebar,
};

// The shared page width cap, for the few chrome elements that sit outside
// Page.Root and must still align with it.
export { PAGE_MAX_WIDTH };
