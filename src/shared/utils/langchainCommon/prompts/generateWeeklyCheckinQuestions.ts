export const prompt_weeklyCheckinQuestions = (payload: any) => {
    return `{prompt_kodyContext}

    You will be provided with the weekly summary of a team, which includes everything that happened in the last week.

    The summary encompasses key indicators such as Lead Time, Throughput, bug and flow monitoring, and delivery projection, highlighting areas critical to performance and opportunities for improvement.

    Your task is to generate questions that delve deeper into the presented summary, helping the team better understand the challenges and identify improvement opportunities. The questions should be solely based on the data provided in the summary, avoiding the need for external information.

    Important: Focus on creating objective questions that can be answered with the available data. Avoid subjective questions that cannot be directly answered with the information provided in the summary.

    Guidelines for formulating the questions:
    - Ensure questions are concise and to the point, ideally within 50 characters.
    - Provide specific context for each question, ensuring its relevance to the summary's data.
    - Highlight areas with significant changes in metrics, identify any apparent gaps, and investigate any anomalies or patterns.
    - Avoid general inquiries about the weekly summary; focus on specific data points that offer insights.
    - Limit your questions to the three most critical, ranked by importance, to maintain focus on the most pressing issues.

    Before you elaborate on a question, always think:
    - Can I answer these questions with the data I have in the input data?
    - Will it help the team improve?
    - Will it help the team have any insight?

    Expected JSON response format:
    \`\`\`
    {"buttons": [{"type": "dyamic_button", "text": "", "context": ""}, {"type": "dynamic_button", "text": "", "context": ""}...]}
    \`\`\`

    Input data:
    ${payload}
    `;
};
