#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const outputPath = path.join(__dirname, 'generated-memory-quality-prompt.json');

function ensurePromptArray(parsedPrompt) {
  if (Array.isArray(parsedPrompt)) {
    return parsedPrompt;
  }

  if (typeof parsedPrompt === 'string') {
    return [
      {
        role: 'user',
        content: parsedPrompt,
      },
    ];
  }

  return [
    {
      role: 'user',
      content: JSON.stringify(parsedPrompt),
    },
  ];
}

function main() {
  const projectRoot = path.resolve(__dirname, '../../..');
  const baseGeneratorPath = path.join(
    projectRoot,
    'evals',
    'promptfoo',
    'generate-memory-prompt.js',
  );
  const flowRoot = path.join(projectRoot, 'packages', 'kodus-flow');
  const baseOutputPath = path.join(
    projectRoot,
    'evals',
    'promptfoo',
    'generated-memory-prompt.json',
  );

  execFileSync('node', ['--loader', 'ts-node/esm', baseGeneratorPath], {
    cwd: flowRoot,
    stdio: 'inherit',
  });

  const basePrompt = JSON.parse(fs.readFileSync(baseOutputPath, 'utf8'));
  const promptMessages = ensurePromptArray(basePrompt);

  fs.writeFileSync(outputPath, JSON.stringify(promptMessages, null, 2));
  console.log(`Generated memory quality prompt at ${outputPath}`);
  console.log(
    'Source prompt is identical to the base memory prompt strategy/tooling; context is injected via additional_information payload.',
  );
}

main();
