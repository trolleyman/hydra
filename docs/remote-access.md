# Remote access and HTTPS

Hydra serves plain HTTP and binds `localhost:26600` by default, so out of the
box it is reachable only from the machine it runs on. This doc covers reaching
it from other devices (a laptop, a phone) and, when you do, getting a real
HTTPS *secure context* rather than plain HTTP.

## Why HTTPS matters here (secure context)

A pile of browser APIs only exist in a *secure context* - an `https://` origin,
or a `localhost` origin. Reached over plain HTTP via a LAN hostname (e.g.
`http://hades:26600`) they are missing entirely, which shows up as features that
silently do nothing:

- `navigator.clipboard` is `undefined`, so copy buttons don't copy (Hydra falls
  back to a legacy `execCommand` path - see `web/src/lib/clipboard.ts` - so most
  copies still work, but it's a workaround).
- `crypto.randomUUID` is missing, which broke chat send until `lib/uuid.ts`
  added a fallback.

Serving Hydra over real HTTPS makes all of these work natively. The catch: the
cert must be *trusted* by the browser. A self-signed cert you click through does
NOT reliably grant secure-context powers in Chrome - so the options below all use
a trusted cert (Tailscale / a real CA / a locally-installed CA), not self-signed.

## The bind + auth model

- Default bind is `localhost:26600` (loopback only). Preview servers use
  `26601-26699` (`internal/cli/server.go`, `internal/preview`).
- Binding a non-loopback address is refused unless an auth key is set:
  `mage deploy:setup` writes one to `.hydra/deploy.toml` (gitignored), and
  `mage prod` / `mage devExpose` bind `0.0.0.0:<port>` with that key required.
- **Localhost is trusted by default.** The auth gate keys off the request's
  remote address, so any request arriving from `127.0.0.1` is treated as
  authenticated. This matters when a TLS terminator runs on the same box (below).
- **`require_local_auth = true` withdraws that exemption.** Set it in
  `.hydra/deploy.toml` (or answer yes to the prompt in `mage deploy:setup`) and
  every TCP client must present the key, localhost included - the local browser
  gets the same login screen, worded for a local connection. Use it whenever
  something on this host proxies outside traffic in from `127.0.0.1`, since
  otherwise those requests are indistinguishable from a local browser.
  The daemon's unix control socket is **not** gated by it: the `hydra` CLI and
  the in-sandbox agent tools go through the socket, which is already 0600, and
  gating it would break them. A `require_local_auth` with no `auth_key` is inert
  (auth stays off) and logs a warning at startup.

## Options

### 1. Plain HTTP on the LAN (`mage prod`)

`mage deploy:setup` then `mage prod` exposes `0.0.0.0:26600`, password-gated. Good
enough for a trusted LAN, but it is plain HTTP - no secure context, so the
clipboard/crypto caveats above apply.

### 2. ngrok (public URL, Google-gated) - `mage deploy:ngrok`

Keeps Hydra on localhost and puts a public `*.ngrok*.dev` URL in front, with
Google sign-in restricted to one email done at ngrok's edge. Real HTTPS (secure
context), reachable from any browser with no client to install - but it is a
public endpoint. See `internal/config/ngrok.go`.

### 3. Tailscale serve (private, trusted cert) - recommended

`mage deploy:tailscale` prints the exact commands and, when tailscale is
installed and logged in, offers to run them for you - first the web UI, then
(separately) the previews. Both prompts default to no. The web UI command it
runs is:

```
tailscale serve --bg --https=26600 http://127.0.0.1:26600
```

Now `https://<machine>.<tailnet>.ts.net:26600/` reaches Hydra from any device on
your tailnet, with a Let's Encrypt cert (real secure context), and **only** your
tailnet can reach it - no public URL. Hydra itself needs no changes: it stays on
localhost, so no auth key and no `0.0.0.0` bind.

The UI is served on its own port rather than the default 443 so that the UI and
the previews form one contiguous range (`26600-26699` by default) - a single
Tailscale ACL grant or firewall rule covers the whole deployment - and so 443
stays free for anything else the machine serves. Tailscale binds the mapping on
the node's tailnet addresses only, so it does not collide with the loopback-bound
Hydra listening on the same port number. Pass `--https=443` instead if you would
rather have a bare `https://<machine>.<tailnet>.ts.net/`.

Prerequisites: install Tailscale and `tailscale up` on the host, and enable
HTTPS certs for your tailnet in the admin console (DNS -> HTTPS).

**Auth nuance.** `tailscale serve` proxies to Hydra from `127.0.0.1`, so every
request looks like localhost and Hydra enforces no password by default. For a
solo tailnet (just your own devices) that is exactly right - tailnet membership
*is* the auth. If your tailnet has other people, either gate access with
Tailscale ACLs on this node, or set `require_local_auth = true` in
`.hydra/deploy.toml` so the proxied requests have to present the key like any
other client (Hydra still can't tell tailnet users apart, but now they all need
the key). The price is that the browser on the host has to log in too.

Latency: on the LAN it's direct WireGuard (negligible); a phone over cellular may
fall back to a DERP relay (+10-40ms), fine for a UI.

Free tier: the Personal plan covers this (serve, MagicDNS, HTTPS certs, and a
generous device/user count). Confirm current limits on Tailscale's pricing page.

### 4. Tailscale Funnel (public, trusted cert, no client)

Same as serve but `tailscale funnel` exposes the service to the public internet
with a trusted cert - the ngrok equivalent, for reaching Hydra from a device you
can't put Tailscale on. Funnel has no built-in identity gate, so if you need
"only me", add auth in front of it (e.g. `oauth2-proxy`) or keep it off and use
serve for your own devices.

### 5. Reverse proxy + locally-trusted cert (offline LAN)

Run Caddy / nginx on the host, terminate TLS, proxy to `127.0.0.1:26600`. Get a
cert from `mkcert` (installs a local CA) or Caddy's `tls internal`. Fully offline,
but you must install the CA root into each device's trust store. If the proxy
listens on a non-loopback address and forwards from localhost, remember the auth
nuance from the bind model above - restrict who can reach the proxy, set
`require_local_auth = true` so the forwarded requests are still checked, or bind
Hydra to `0.0.0.0` with an auth key so it checks the password itself.

## Live server previews over HTTPS

Previews (`[previews.<name>]`, see `docs/artifacts.md`) each run behind
their own proxy port in `26601-26699`, separate from the main web port. Two things
make them work behind a TLS front:

1. **The preview URL follows the page's scheme.** `previewURL`
   (`internal/http/previews.go`) emits a protocol-relative `//host:port/`, so on
   an HTTPS Hydra page the preview link is HTTPS too. (A hardcoded `http://`
   would be blocked as mixed content on an HTTPS page.)
2. **Each preview port needs its own TLS mapping.** Because previews use distinct
   ports, one `tailscale serve` for the main port doesn't cover them. `mage
   deploy:tailscale` offers to serve the whole range for you (the second prompt);
   the equivalent by hand is:

   ```
   for p in $(seq 26601 26699); do tailscale serve --bg --https=$p http://127.0.0.1:$p; done
   ```

   A preview on `26601` then opens at `https://<machine>.<tailnet>.ts.net:26601/`.
   The same idea applies to a reverse proxy (one `:port` vhost per preview port);
   the tailnet cert is per-hostname, so it covers every port for free. Narrow the
   range in `config.toml` (`preview_ports`) if serving all of it is more than you
   need.

   Inspect or undo with `tailscale serve status` / `tailscale serve reset`.

3. **Serving the range + an exposed Hydra: previews drop to loopback.**
   `tailscale serve --https=$p` binds port `$p` on this node's *tailnet
   addresses* (`100.x.y.z` and the `fd7a:` IPv6), for all 99 ports. A
   loopback-bound Hydra never notices. But an exposed one (`mage prod`,
   `HYDRA_API_ADDR=0.0.0.0:26600`) binds the **wildcard**, and a wildcard bind
   collides with a specific-address listener on the same port even though
   nothing holds the wildcard itself - so every port in the range comes back
   `address already in use`.

   `allocListener` (`internal/preview`) handles this: it tries the wildcard
   port by port first, and only if the whole range is taken does it fall back to
   `127.0.0.1` (logging once). That is the right answer here - the serve
   mappings proxy to `http://127.0.0.1:$p`, which is exactly what Hydra then
   binds - but it does mean previews are reachable *through Tailscale only*, not
   directly over plain HTTP from the LAN. Run `tailscale serve reset` if you
   want the ports back.

   Before that fallback existed this was a hard failure: every preview start
   returned `no free preview port in 26601-26699`, which the UI surfaced as an
   Open tab that closed itself immediately.

If serving 99 ports feels heavy, a future improvement is to mount previews under a
path on the main port (`/preview/<slot>/`) so a single TLS mapping covers
everything; that needs a preview-proxy + frontend URL change and is not built yet.
For now, serving the ports you actually use is the simple path.
