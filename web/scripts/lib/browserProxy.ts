// Playwright launch options that route the browser through Hydra's egress proxy.
//
// Inside a sandboxed head, outbound traffic goes through a filtering proxy
// advertised in HTTPS_PROXY, and under `network.mode = "hard"` that proxy is the
// ONLY route out: the network namespace has no resolver of its own. curl, node
// and git read HTTPS_PROXY from the environment and work; Chromium does not, so
// it resolves names itself inside the namespace and every external request dies
// with ERR_NAME_NOT_RESOLVED. That is why screenshots taken in a head used to
// render with fallback fonts - Merriweather and Roboto Flex are loaded from
// fonts.googleapis.com, which is on the allow-list and was reachable all along.
//
// The bypass is not optional. Playwright appends Chromium's `<-loopback>` when a
// proxy is set, which UNDOES Chromium's built-in "never proxy loopback" rule - so
// without this, every request to the local simulation server would be sent to the
// proxy, which would try to reach it on the HOST's loopback and fail. Naming the
// loopback hosts here puts that rule back.
//
// Outside a sandbox HTTPS_PROXY is unset and this returns nothing, so a browser
// launched on the host behaves exactly as before.
export function proxyLaunchOptions(): { proxy?: { server: string; bypass: string } } {
  const server = process.env.HTTPS_PROXY || process.env.https_proxy
  if (!server) return {}
  return { proxy: { server, bypass: 'localhost,127.0.0.1,::1' } }
}
