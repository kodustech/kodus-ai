export const prompt_potentialIssues = () => {
    return `

# Potential Issues - Specific Instructions

## Category Definition
This category focuses on identifying potential bugs, logical errors, and issues that might arise during runtime.

## Specific Objectives
- Identify type issues (missing types, untyped parameters/returns)
- Detect possible runtime errors
- Identify logical inconsistencies
- Find code contract violations
- Detect null/undefined handling problems
- Identify race conditions in asynchronous code
- Find issues in loops and conditionals

## Concrete Examples
- Accessing properties of potentially null objects
- Promises not properly handled
- Race conditions in asynchronous operations
- Infinite loops or incorrect exit conditions
- Problematic implicit type conversions
- Incorrect comparisons (== vs ===)
- Unintended side effects

## Severity Criteria
- Low: Issues that would rarely cause failures or would have minimal impact
- Medium: Issues that may cause incorrect behavior in specific scenarios
- High: Issues that will likely cause errors in production
- Critical: Issues that will certainly cause serious failures or unexpected behaviors

## Suggestion Structure
- Clear explanation of the potential problem
- Impact of the issue (when and how it might manifest)
- Specific and concrete solution
    `;
};
