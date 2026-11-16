// Observational preload: every scan/model/lens argument, success value and
// thrown error is forwarded unchanged. No prompts, bodies or error messages
// are logged. The case id and task are bounded benchmark labels.
const Module = require('module');
const { AsyncLocalStorage } = require('async_hooks');
const context = new AsyncLocalStorage();
const observed = new WeakSet();
const originalLoad = Module._load;
const label = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,90}$/.test(value) ? value : 'other';
Module._load = function (request, parent, isMain) {
  const value = originalLoad.apply(this, arguments);
  if (request.includes('llm/llm') && value.LLM && !observed.has(value.LLM)) {
    const owner = value.LLM;
    observed.add(owner);
    const run = owner.run;
    owner.run = function (input) {
      return run.apply(this, arguments).catch(error => {
        let last = error;
        for (let i = 0; i < 5; i++) {
          const next = last?.lastError ?? (Array.isArray(last?.errors) ? last.errors.at(-1) : undefined) ?? last?.cause;
          if (!next || next === last) break;
          last = next;
        }
        console.error('OBSERVED_CALL_FAILURE', JSON.stringify({
          case: label(context.getStore()),
          task: label(input.runName),
          errorName: label(error?.name),
          rootName: label(last?.name),
          statusCode: Number.isInteger(last?.statusCode) ? last.statusCode : null,
        }));
        throw error;
      });
    };
  }
  if (request.includes('scan-repo') && value.scanRepository && value.pricingResolver) {
    const run = value.scanRepository;
    return { ...value, scanRepository: function (input) {
      const args = arguments;
      return context.run(input.c?.id, () => run.apply(this, args));
    } };
  }
  if (!request.includes('security-scan-engine') || !value.SecurityScanEngine) return value;
  const Base = value.SecurityScanEngine;
  return { ...value, SecurityScanEngine: class extends Base {
    constructor(...args) {
      super(...args);
      const run = this.runLens;
      this.runLens = async (...input) => {
        const result = await run(...input);
        console.error('OBSERVED_LENS_RESULT', JSON.stringify({
          case: label(context.getStore()),
          agent: label(input[0].agentName),
          finishReason: label(result.finishReason),
          incompleteReason: result.incompleteReason ? label(result.incompleteReason) : null,
          submittedResult: result.submittedResult,
          errorName: result.errorName ? label(result.errorName) : null,
          unverified: result.unverifiedByVerify?.length,
          kept: result.findings?.suggestions?.length,
        }));
        return result;
      };
    }
  } };
};
