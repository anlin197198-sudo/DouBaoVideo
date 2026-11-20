import { createPrivateVideoProbeRunner, PRIVATE_VIDEO_PROBE_RESULT_KEY } from "./private-video-probe-page";

const pageHref = window.location.href;
const abort = new AbortController();
const stop = () => abort.abort();
window.addEventListener("pagehide", stop, { once: true });
window.addEventListener("hashchange", stop, { once: true });

void createPrivateVideoProbeRunner()(pageHref, abort.signal).then(result => {
  if (result !== null && !abort.signal.aborted && window.location.href === pageHref) {
    Object.defineProperty(window, PRIVATE_VIDEO_PROBE_RESULT_KEY, {
      value: result, configurable: false, writable: false, enumerable: false,
    });
  }
}).finally(() => {
  window.removeEventListener("pagehide", stop);
  window.removeEventListener("hashchange", stop);
}).catch(() => {
  // A host that receives no own result must time out. Do not emit exception details.
});
