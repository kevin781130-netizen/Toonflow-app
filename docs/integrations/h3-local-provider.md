# Toonflow ⇄ H3 Director: opt-in Provider (P0)

Both applications run independently. This integration is an optional media
Provider for Toonflow's existing video-generation node, not a second frontend
or an embedded H3 runtime.

## Activate locally (Windows, trusted localhost only)

1. Start the native H3 Director separately, with the H3 feature branch and
   `H3_TOONFLOW_INTEGRATION=1` set **before the H3 process starts**.
2. Start Toonflow separately. In **Settings → Media Models**, select
   **Add Provider → built-in H3 Local Director** and confirm installation.
   Toonflow persists an installed copy in its existing application Provider
   directory; a Git import alone does **not** install or expose a video model.
3. Configure the Provider's `baseUrl` (default
   `http://127.0.0.1:17960`) and, in a Video Generation node, select
   **Local H3 Director → H3 Native Shot**.
4. Choose a duration of 4–15 seconds and a text prompt. The
   **output aspect ratio is fixed by the explicitly verified H3 workflow
   template**; it is not editable in Toonflow. The UI deliberately omits
   `ratio` from requests to this model. References, video/audio inputs,
   arbitrary controls and unsupported resolutions remain disabled.
5. The H3 server owns native Take receipts, successful ComfyUI output history
   and verified SHA-256 hashes. The Toonflow Provider independently checks
   the returned video bytes in its isolated WebCrypto-enabled VM before
   accepting an MP4/WebM output.

## Detach without breaking either app

- In Toonflow, delete the installed H3 media Provider via the existing Media
  Model settings. Other installed Providers continue working.
- In H3, unset `H3_TOONFLOW_INTEGRATION` and restart. The optional
  result bridge does not load. H3 can still operate directly.
- No shared project store, database, runtime files or frontend imports exist
  across repositories. In-flight tasks must be reconciled before detaching.
- This feature branch does not modify Master or Main.

## P0 regression checks

```bash
node --experimental-strip-types --test packages/providers/src/media/h3Local.p0.test.mjs
node --experimental-strip-types --test packages/providers/src/media/h3Local.detach.test.mjs
bun run typecheck
bun run build
```

The first two suites are isolated contract checks; full Bun/Windows GPU
acceptance is mandatory before shipping. Never treat metadata, a queued
receipt, or a successful build as proof that real H3 video output succeeded.
