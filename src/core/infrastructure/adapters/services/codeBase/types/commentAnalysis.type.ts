import { ReviewOptions } from '@/config/types/general/codeReview.type';
import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';

export interface UncategorizedComment {
    id: string;
    body: string;
    language: string;
}

export interface CategorizedComment {
    id: string;
    body: string;
    category: keyof ReviewOptions;
    severity: SeverityLevel;
}

export type CommentFrequency = {
    categories: {
        [key in keyof ReviewOptions]: number;
    };
    severity: {
        [key in SeverityLevel]: number;
    };
};

export enum AlignmentLevel {
    LOW = 'low',
    MEDIUM = 'medium',
    HIGH = 'high',
}
