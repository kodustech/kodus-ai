import { FileChange } from "@/config/types/general/codeReview.type";

export interface ISecurityAnalysisService {
    analyzeSecurity(file: FileChange): Promise<any>;
}
