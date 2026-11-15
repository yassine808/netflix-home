# Benchmarks

Every measurement that drove a performance decision for the remux/download
pipeline lives here as a CSV table. Append new runs, never overwrite old ones.

| file | what it holds |
|---|---|
| `remux-pipeline.csv` | one row per ffmpeg invocation on the fixed 90 s clip: encode settings, wall time, CPU, GPU/NVENC, output size |
| `copy-on-hdd.csv` | container-copy timings on the real library disk (`G:`, 1 TB 5400 rpm HDD), with and without `+faststart` |
| `real-episodes.csv` | the app's own log line for real downloads, one row per job |
| `audio-encode.csv` | audio encoder comparisons on the real E-AC3 tracks of one release |
| `raw/` | untouched `results.json` from each harness run |

## Machine

- i5-10400F, 32 GB, RTX 3070 (driver 621.01), Windows 11
- `C:` Samsung MZ7KM960 SSD, `G:` ST1000LM024 5400 rpm HDD (library + torrent cache)
- ffmpeg 6.1.1 (`node_modules/ffmpeg-static`)

## How each table was produced

- `remux-pipeline.csv` — `bench-v2.ps1` (old vs new pipeline) and `bench3.ps1`
  (settings sweep) in `C:\Users\Administrator\AppData\Local\Temp\opencode\remux-bench\`.
  Same source (`src10bit.mkv`, 90.263 s, 1920x1080 HEVC Main10), same
  `-map 0:a:0`, same `-sn -dn -map_chapters -1`, same `-f mp4`. Only the video
  pipeline differs. `speed_x` = source duration / wall time.
- `copy-on-hdd.csv` — ffmpeg `-c copy` of a real 1 GB, 30 min episode
  (`Cyberpunk Edgerunners S02E10 1080p.mp4`) reading and writing on `G:`.
  `plain-copy` is `Copy-Item` of the same file for the raw disk baseline.
  `mb_per_s` = (read + written) / wall time.
- `real-episodes.csv` — copied from the app's `remuxed N min to H.264 in X s
  (Yx realtime)` line, which times `remuxToMp4` only. Download and subtitle
  time are not included.

## What did not work

- `+faststart` — costs a full rewrite of the output (see `copy-on-hdd.csv`).
- Copying E-AC3 into the MP4 instead of re-encoding it: the file builds and
  plays, but Brave reports `canPlayType('audio/mp4; codecs="ec-3"')` as empty
  and decodes 0 audio bytes, so it is silent. Same for AC-3.
- Opus in MP4: Brave does decode it (`canPlayType` = `probably`, 225,852 audio
  bytes in 6.5 s), but it encodes no faster than AAC `fast` on the same track
  (5.1: 64.94 s against 67.87 s), so it buys nothing.
- `aac_mf` (MediaFoundation) is slower than native AAC with `-aac_coder fast`.
- Fragmenting the MP4 (`frag_keyframe+empty_moov`) is no faster than a plain mux.

## Reading the numbers

- `gpu_pct` is whole-GPU utilisation, `nvenc_pct` is the encoder engine only.
  A transcode that sits at 80-90 % `nvenc_pct` cannot be made faster by
  touching anything but the encoder settings; a copy sits near 26 % because
  the GPU is idle and the disk is the limit.
- Times taken while the machine was in use are kept as-is: they describe the
  machine as the app actually runs on it. `notes` says when that was the case.
