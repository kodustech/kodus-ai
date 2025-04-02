export const ARTIFACTS_STRUCTURE_DATA = {
    artifacts_glossary: {
        mostRecentArtifacts: {
            'date': 'Date the artifacts were recorded',
            'artifacts': 'Array of objects representing individual artifacts',
            'artifacts.[].name': 'Name of the artifact',
            'artifacts.[].description':
                'Description of the artifact, detailing the issue identified and its implications',
            'artifacts.[].category':
                "Category of the artifact, e.g., 'Monitoramento de Fluxo'",
            'artifacts.[].resultType':
                "Result type indicating the outcome, e.g., 'Negativo'",
            'artifacts.[].howIsIdentified':
                'Explanation of how the issue was identified',
            'artifacts.[].whyIsImportant':
                'Explanation of why the issue is important',
            'artifacts.[].impactArea':
                "Areas impacted by the issue, e.g., 'Qualidade de entrega, Velocidade de entrega'",
            'artifacts.[].analysisFinalDate':
                'Final date of the analysis in ISO 8601 format',
            'artifacts.[].frequenceType':
                "Frequency type indicating how often the analysis is performed, e.g., 'daily', 'weekly'",
            'artifacts.[].additionalData':
                'Array for any additional data related to the artifact',
        },
        previousArtifacts:
            "Array of previous artifact objects, similar in structure to 'mostRecentArtifacts'",
    },
};
