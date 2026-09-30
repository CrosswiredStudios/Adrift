# Cloud texture credits

Both files come from the Babylon.js playground demo
["Volumetric clouds" by celeste-twinkle](https://celeste-twinkle.github.io/Babylon-App-Show/clouds/)
(the same demo `src/world/cloudVolume.ts` is ported from).

| File | Source | Notes |
| --- | --- | --- |
| `pebbles.png` | [pebbles.png](https://celeste-twinkle.github.io/Babylon-App-Show/clouds/pebbles.png) | Grayscale weather map that shapes the cloud deck (2D, wrapped). |
| `greyNoise3D.bin` | [greyNoise3D.bin](https://celeste-twinkle.github.io/Babylon-App-Show/clouds/greyNoise3D.bin) | Shadertoy-style 3D volume: 20-byte `BIN\n` header + 32x32x32x1 raw bytes. |

If either file fails to load at runtime, `cloudVolume.ts` falls back to
procedurally generated weather + volume noise seeded from the planet, so the
deck still renders (and stays deterministic offline).
