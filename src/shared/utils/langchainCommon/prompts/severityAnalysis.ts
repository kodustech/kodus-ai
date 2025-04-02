import { CodeSuggestion } from '@/config/types/general/codeReview.type';
import { generateSelectedMatrices } from '../../helpers/rankScore.helper';

import { validateSelectedCategories } from '../../helpers/rankScore.helper';

export const prompt_severity_analysis_system = () => {
    return `You are Kody PR-Severity-Analyzer, an expert at evaluating code suggestions and determining their critical impact level.

Your task is to analyze each code suggestion and assign a severity level (critical, high, medium, low) based on its potential impact and the specific category it belongs to.

<rules>
1. Consider both the category and actual impact when assigning severity
2. Focus on concrete consequences rather than theoretical problems
3. Evaluate based on security risks, performance impact, and maintainability effects
4. Consider the scope of impact (localized vs system-wide)
</rules>`;
};

export const prompt_severity_analysis_user = (
    codeSuggestions: CodeSuggestion[],
    selectedCategories: unknown,
): string => {
    try {
        const validatedCategories =
            validateSelectedCategories(selectedCategories);
        const selectedCategoryMatrices =
            generateSelectedMatrices(validatedCategories);

        if (!codeSuggestions?.length) {
            return '<error>No code suggestions provided</error>';
        }

        return `<context>
 <categories>${
     Object.entries(validatedCategories)
         .filter(([_, value]) => value === true)
         .map(([category]) => category)
         .join(', ') || 'none'
 }</categories>

 <severityMatrices>
 ${selectedCategoryMatrices}
 </severityMatrices>

 <suggestions>
 ${
     codeSuggestions
         .map((suggestion, index) => {
             try {
                 return `
 <suggestion id="${index + 1}">
 <category>${suggestion?.label || 'unknown'}</category>
 <content>${suggestion?.suggestionContent || ''}</content>
 <existingCode>${suggestion?.existingCode || ''}</existingCode>
 <improvedCode>${suggestion?.improvedCode || ''}</improvedCode>
 </suggestion>`;
             } catch {
                 return '';
             }
         })
         .filter(Boolean)
         .join('\n') || '<error>Failed to process suggestions</error>'
 }
 </suggestions>
 </context>

 Analyze each suggestion using the provided severity matrices and return severity levels in this format:
 <severityAnalysis>
 <results>
 {suggestion_id}|{severity_level}
 </results>
 </severityAnalysis>`;
    } catch {
        return '<error>Failed to generate severity analysis prompt</error>';
    }
};
