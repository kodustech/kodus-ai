// Read-only observer for manual contract diagnostics; forwards every argument
// and returns the exact production result without replacing engine behavior.
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const value = originalLoad.apply(this, arguments);
  if (!request.includes('security-scan-engine') || !value.SecurityScanEngine) return value;
  const Base = value.SecurityScanEngine;
  return { ...value, SecurityScanEngine: class extends Base {
    constructor(...args) {
      super(...args);
      const run = this.runLens;
      this.runLens = async (...input) => {
        const result = await run(...input);
        console.error('OBSERVED_LENS_RESULT', JSON.stringify({
          agent: input[0].agentName,
          finishReason: result.finishReason,
          incompleteReason: result.incompleteReason,
          submittedResult: result.submittedResult,
          errorName: result.errorName,
          unverified: result.unverifiedByVerify?.length,
          kept: result.findings?.suggestions?.length,
        }));
        return result;
      };
    }
  } };
};
