const fs = require('fs');
const path = require('path');

// Path to the JSON file
const jsonFilePath = path.join(__dirname, '../src/core/infrastructure/adapters/services/kodyRules/data/library-kody-rules.json');

// Read the JSON file
const data = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));

// Function to validate unique UUIDs
function validateUniqueUuids(data) {
    const uuids = new Set();
    const duplicates = [];

    // Iterate through all languages and rules
    for (const language in data) {
        data[language].forEach(rule => {
            if (uuids.has(rule.uuid)) {
                duplicates.push({
                    uuid: rule.uuid,
                    language,
                    name: rule.name
                });
            }
            uuids.add(rule.uuid);
        });
    }

    if (duplicates.length > 0) {
        console.error('❌ Duplicate UUIDs found:');
        duplicates.forEach(dup => {
            console.error(`  UUID: ${dup.uuid}`);
            console.error(`  Language: ${dup.language}`);
            console.error(`  Rule Name: ${dup.name}`);
            console.error('---');
        });
        throw new Error('Duplicate UUIDs found. Please fix them before proceeding.');
    }

    console.log('✅ All UUIDs are unique!');
    console.log(`Total rules: ${uuids.size}`);
}

// Function to convert examples
function convertExamples(rule) {
    const examples = [];

    if (rule.bad_example) {
        examples.push({
            snippet: rule.bad_example,
            isCorrect: false
        });
        delete rule.bad_example;
    }

    if (rule.good_example) {
        examples.push({
            snippet: rule.good_example,
            isCorrect: true
        });
        delete rule.good_example;
    }

    // Add the examples array even if it's empty
    rule.examples = examples;

    return rule;
}

// Validate UUIDs before making changes
validateUniqueUuids(data);

// Process each language and its rules
for (const language in data) {
    data[language] = data[language].map(rule => convertExamples(rule));
}

// Save the updated JSON file
fs.writeFileSync(jsonFilePath, JSON.stringify(data, null, 4));

console.log("✅ JSON file successfully updated!");
