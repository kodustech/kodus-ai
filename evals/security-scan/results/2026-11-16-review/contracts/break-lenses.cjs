// Fault injection for the wiring probe only; never used by production.
const Module = require('module');
const original = Module._load;
Module._load = function(request, parent, isMain) {
  const value = original.apply(this, arguments);
  if (request.includes('security-scan-engine') && value.SecurityScanEngine) {
    const Base = value.SecurityScanEngine;
    return { ...value, SecurityScanEngine: class extends Base {
      constructor(...args) {
        super(...args);
        this.runLens = async function() {
          console.error('DELIBERATE_LENS_FAILURE');
          throw new Error('deliberate unavailable lens');
        };
      }
    } };
  }
  return value;
};
