// A page built from one version keeps running after the server updates. Compare the build stamped into the
// page with the server's; a mismatch means a reload is due, but never while a stream is running.
export function pageIsStale(pageVersion, serverVersion) {
  return !!pageVersion && !!serverVersion && pageVersion !== 'dev' && serverVersion !== 'dev' && pageVersion !== serverVersion;
}
export function reloadDecision(pageVersion, serverVersion, streaming) {
  if (!pageIsStale(pageVersion, serverVersion)) return 'current';
  return streaming ? 'after-stream' : 'now';
}
