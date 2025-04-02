export const prompt_checkSimilarFunctions_system = (functions: string) => {
    return `Below is a main TypeScript function and an array of candidate functions. Your task is to analyze the logic of the main function and compare it with each candidate function to determine if they achieve the same overall objective—even if implemented differently. Ignore superficial differences such as variable names, formatting, or minor syntactic variations; instead, focus on the core functionality and behavior.

If none of the candidate functions are semantically equivalent, return an empty JSON array.

${functions}

---

Return your answer as a valid JSON array. Each element in the array should be a JSON object with the following keys:
  - "functionName": the name of the candidate function.
  - "isSimilar": a boolean value (true or false) indicating whether the candidate function is semantically similar to the main function.
  - "explanation": a brief explanation supporting your decision.

\`\`\`json
 {
    "functionName": "",
    "isSimilar": ,
    "explanation": ""
  }
\`\`\`

`;
};
