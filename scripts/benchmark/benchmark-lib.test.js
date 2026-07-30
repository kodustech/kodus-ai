const assert = require('assert');
const {
  shouldIncludeInBenchmarkEvaluation,
  classifyBenchmarkDeliveryStage,
} = require('./benchmark-lib');

function run() {
  assert.strictEqual(
    shouldIncludeInBenchmarkEvaluation({ deliveryStatus: 'sent' }),
    true,
  );
  assert.strictEqual(
    shouldIncludeInBenchmarkEvaluation({ deliveryStatus: 'failed' }),
    false,
  );
  assert.strictEqual(
    shouldIncludeInBenchmarkEvaluation({ deliveryStatus: 'missing' }),
    false,
  );
  assert.strictEqual(
    shouldIncludeInBenchmarkEvaluation({}),
    false,
  );
  assert.strictEqual(
    classifyBenchmarkDeliveryStage({ deliveryStatus: 'sent' }),
    'sent',
  );
  assert.strictEqual(
    classifyBenchmarkDeliveryStage({ deliveryStatus: 'failed' }),
    'discarded',
  );
  assert.strictEqual(
    classifyBenchmarkDeliveryStage({}),
    'discarded',
  );
  console.log('benchmark-lib.test.js passed');
}

run();
