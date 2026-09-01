// Owns only request lifecycle. It deliberately knows nothing about markets,
// rankings, or trade values.
export function createScanCoordinator(AbortControllerImpl = AbortController) {
  let sequence = 0;
  let active = null;

  return {
    begin() {
      active?.controller.abort();
      const controller = new AbortControllerImpl();
      const request = { id: ++sequence, controller, signal: controller.signal };
      active = request;
      return request;
    },
    isCurrent(request) { return active?.id === request?.id; },
    complete(request) { if (this.isCurrent(request)) active = null; },
    abort() { active?.controller.abort(); active = null; }
  };
}
