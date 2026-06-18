# Diff Artifacts

Diff artifacts are per-project commands that render **visual** artifacts —
screenshots, or videos (screen recordings) — of a checkout. The diff viewer runs
each command against both sides of a comparison (the base ref and the head ref or
your uncommitted working tree) and shows the outputs that differ, side by side.

Configure them as `[[artifacts]]` blocks in `.hydra/config.toml`, or via the
**Diff Artifacts** editor in the web Settings page (which writes the same config).

## Configuring

```toml
[[artifacts]]
name = "screenshots"
command = "bun run screenshots.ts"
timeout_sec = 900
```

| Field         | Required | Description |
| ------------- | -------- | ----------- |
| `name`        | yes      | Unique label, also used as the cache directory. |
| `command`     | yes      | Shell command, run via `bash -c` in the checkout directory. |
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
