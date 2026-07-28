# Diff Artifacts

Diff artifacts are per-project commands that render **visual** artifacts —
screenshots, or videos (screen recordings) — of a checkout. The diff viewer runs
each command against both sides of a comparison (the base ref and the head ref or
your uncommitted working tree) and shows the outputs that differ, side by side.

Configure them as `[artifacts.<name>]` tables in `.hydra/config.toml`, or via the
**Diff Artifacts** editor in the web Settings page (which writes the same config).

A **live, clickable preview** of the app is a different thing and lives in its own
`[previews.<name>]` section — see [Previews](#previews) below.

The same scripts are also browsable **single-sided** in the repository view: a
dynamic `.hydra/artifacts` folder appears in the file tree (nested under the real
`.hydra/` folder) whenever the ref configures at least one script. Each script
shows as a "file"; opening it **lazily** generates that script for the ref you are
browsing — nothing runs until you click — and renders its output files (no
before/after, since the repository view shows one ref at a time). A refresh button
regenerates, chiefly to retry a cached failure.

## Configuring

```toml
[artifacts.screenshots]
command = '''
cd web
npm install
node scripts/take-screenshots.ts
'''
timeout_sec = 900
```

The command is a **script**, not a one-liner: write it as a multi-line `'''`
block with one step per line, and comment the steps that need explaining. It is
run through `bash -c` either way, but a wall of `&&` is unreadable in the config
file and in the Settings editor alike.

| Field         | Required | Description |
| ------------- | -------- | ----------- |
| `name`        | yes      | Unique label, also used as the cache directory. |
| `command`     | yes      | Shell script, run via `bash -c` in the checkout directory. |
| `timeout_sec` | no       | Max seconds the command may run (`0` = built-in default). |
| `unsafe_host` | no       | Run on the host with **no sandbox** — full access to your machine and credentials. Only for audited, self-contained commands you trust against every ref you compare. Honored only when the trusted live config authorizes that exact command, so a branch cannot grant itself host access. Default `false`. |

By default the command runs **inside the OS sandbox** (the same confinement
agents get). The checkout, the output directory, the dev caches and the git
common dir are writable; credentials are masked; network is on.

### Environment variables

The command is given:

| Variable                | Value |
| ----------------------- | ----- |
| `HYDRA_ARTIFACT_OUTPUT` | Directory to write image/video files into. |
| `HYDRA_ARTIFACT_SOURCE` | The checkout directory. |
| `HYDRA_ARTIFACT_REF`    | The resolved git ref. |

Results are cached per commit under `.hydra/local/artifacts/out/<name>/<version-key>`
(gitignored, never committed), so re-viewing a diff is free.

## Streaming outputs (`::hydra:artifact::`)

By default every output is collected when the command **exits**, so all the tiles
appear (and get diffed) at once. A command can instead stream them **as they
render**, like the tests panel's `::hydra:test:*::` markers: right after writing a
file (and its `.meta` sidecar), print a line on stdout —

```sh
echo "::hydra:artifact:: home-dark.png"
```

— where the path is relative to `$HYDRA_ARTIFACT_OUTPUT`. Hydra scans just that one
file (hash + pixel size + sidecar), diffs it against the other side the moment both
sides know it (the counterpart has the file, or has already settled without it — so
each tile is pixel-diffed exactly once), and streams the tile straight into the
panel while the rest of the run continues.

The marker is **optional and additive**: emit none and every output is still
collected by the post-exit scan, which also reconciles anything the markers missed.
Emit it only **once the file is fully written** — a marker for a not-yet-flushed
file is ignored (the final scan catches it). Print `::hydra:progress:: <text>` to
set the live progress header shown while the command runs.

## How files are compared

Each output file is matched by name across the two sides and classified as
added / removed / modified / unchanged. How "modified vs unchanged" is decided
depends on the format:

| Format(s)                         | Comparison |
| --------------------------------- | ---------- |
| `.png`, `.jpg`, `.gif`            | Decoded and compared **pixel-by-pixel**, so cosmetic re-encodes (different compression level, added EXIF/metadata, timestamp chunks) are ignored. |
| `.webm` (video)                   | Compared **frame-by-frame** via ffmpeg when it is installed; otherwise by byte hash (see below). |
| `.webp`, `.avif`, `.svg`, `.bmp`, `.pdf` | Compared by **byte hash** — any byte difference reads as modified. |

## Video (`.webm`)

Video is supported via **`.webm` only**.

Because the Go standard library can't decode VP8/VP9, Hydra compares video
out-of-process with **ffmpeg**: when a `.webm` file differs byte-wise, it runs
`ffmpeg -f framemd5` on both sides and compares the per-frame content hashes.
Identical frames are reported as **unchanged**, even if the container bytes
differ (muxing timestamps, writing-app tags, segment UIDs) — which would
otherwise show up as a spurious "modified".

- **Install ffmpeg** to get frame-accurate video diffs. It's the same tool you
  use to produce the `.webm`, and it's an opportunistic, soft dependency — Hydra
  stays a single binary with no extra Go/system library.
- When ffmpeg is **not** installed (or fails to decode a file), Hydra falls back
  to a raw byte-hash comparison and marks the result with a **`byte-compared`**
  badge in the diff viewer, because that "modified" verdict may be spurious.
- **Encode losslessly**, e.g.:

  ```sh
  ffmpeg -i in.mp4 -c:v libvpx-vp9 -lossless 1 out.webm
  ```

  The frame check compares *decoded pixels*, so a lossy encode of otherwise
  identical frames still reads as "modified". Lossless keeps identical frames
  identical — and also makes the byte-hash fallback meaningful.

The video viewer has a shared transport — play/pause, a scrubber, a loop toggle,
a speed select, and **frame-step buttons** either side of play/pause to advance
one frame at a time. HTML5 video exposes no frame rate, so by default a step
assumes 30fps. Declare the real rate in the `.meta` sidecar (see below) to make
stepping frame-accurate:

```json
{ "fps": 60 }
```

## Tags & filtering

Alongside an output file `home.png` (or `home.webm`) the command may write a JSON
sidecar `home.png.meta`. It is a single, extensible home for per-file metadata:

```json
{ "tags": ["theme::dark", "viewport::phone"], "fps": 60 }
```

The diff viewer shows the tags as labels and offers a filter. A `category::value`
tag is a scoped label — only one value per category is kept (the last wins);
plain tags are free-form. When a set mixes images and video, a built-in
**type** filter (image / video) appears too.

`fps` applies to video only and sizes the viewer's frame-step buttons (see
above); a non-positive value is ignored with a warning. Both keys are optional —
omit either, or skip the sidecar entirely. A malformed sidecar is reported as a
build warning and otherwise ignored.

## Previews

A **preview** is a live, clickable running copy of the app at a checkout, as
opposed to the still images an artifact renders. Each appears in the Previews row
on the agent page; Hydra proxies a dedicated port to it, spawning the server when
its link is first opened, keeping it warm while requests flow, and tearing it
down once idle (the next visit respawns it). The runner is `internal/preview`.

```toml
[previews.demo]
command = '''
npm install
npm run build
npm run serve -- --host "$HYDRA_PREVIEW_ADDR"
'''
ready_timeout_sec = 900
```

| Field               | Required | Description |
| ------------------- | -------- | ----------- |
| `name`              | yes      | Unique label, shown in the Previews row (the table key). |
| `command`           | yes      | Shell script, run via `bash -c` in the checkout directory. It must bind `$HYDRA_PREVIEW_ADDR` and stay in the foreground. |
| `idle_timeout_sec`  | no       | Teardown after this long with zero in-flight proxied requests; open WebSocket/long-poll connections count as in-flight (`0` = default 300). |
| `ready_timeout_sec` | no       | Max seconds from spawn to ready, builds included (`0` = default 900). |
| `unsafe_host`       | no       | Run on the host with **no sandbox**. Worse than for an artifact — a preview runs the previewed ref's code as a long-lived resident process. Gated by the trusted live config, and that authorization is *kind-scoped*: trusting an artifact of the same name+command does not authorize the preview. Default `false`. |
| `strict`            | no       | Run under `set -eo pipefail` so a failing build step aborts the spawn instead of serving a half-built tree. Default `true`. |
| `enabled`           | no       | `false` hides the preview from the agent page. Default `true`. |

The command is given:

| Variable               | Value |
| ---------------------- | ----- |
| `HYDRA_PREVIEW_ADDR`   | The full `host:port` to bind — `0.0.0.0:PORT` under network mode `hard`, else `127.0.0.1:PORT`. Bind **this**, not a hardcoded `127.0.0.1`, or hard mode 502s. |
| `HYDRA_PREVIEW_PORT`   | Just the port. |
| `HYDRA_PREVIEW_SOURCE` | The checkout directory. |

Readiness is the first successful dial of the port, or an explicit
`::hydra:server:ready::` line on stdout, whichever comes first;
`::hydra:progress:: <text>` sets the headline shown while it builds. Which ports
the proxy allocates from is the top-level `preview_ports` range.

Previews used to be written as an `[artifacts.<name>]` table with
`type = "server"`. That spelling still parses — including at an older git ref,
whose config Hydra reads as-is when previewing it — and is upgraded to a
`[previews.<name>]` on read (`upgradeServerArtifacts` in `internal/config`). The
renderer never writes `type` back, so the next config save migrates the file.

### Previews: caching

Previews mirror a live worktree, so stale caches would defeat their purpose.
Two layers keep them fresh, and neither needs (or offers) configuration:

- **The preview reverse proxy** rewrites every upstream response's freshness to
  `Cache-Control: no-cache` (revalidate-before-use) while PRESERVING the
  upstream `ETag`/`Last-Modified` validators (`forceRevalidate` in
  `internal/preview/proxy.go`). This is applied at the proxy layer, so it works
  for ANY preview server implementation - a Vite dev server, a Go binary, a
  static file server - without that server cooperating. Unchanged assets still
  answer with a cheap 304, so a well-behaved upstream keeps most of the
  performance of caching; only the "serve from cache without asking" behavior
  is removed. Deliberately not configurable: a preview that may serve stale
  bytes silently hides exactly the changes it exists to show, and the 304 path
  already keeps revalidation cheap.
- **Hydra's own web UI** (the embedded SPA) serves `assets/*` (content-hashed
  Vite bundles) as `immutable` and everything with a stable name
  (`index.html`, icons) as `no-cache` (`setFrontendCacheHeader` in
  `internal/cli/server_frontend.go`). Embedded files carry no modtime, so
  without explicit headers browsers heuristically cached `index.html` and kept
  showing an old build after a rebuild + restart.

The status/loading endpoints the preview holding page uses are `no-store`.
