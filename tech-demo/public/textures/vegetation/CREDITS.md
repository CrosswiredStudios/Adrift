# Vegetation texture credits

All textures are from [ambientCG](https://ambientcg.com) and released under the
[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) licence
(no attribution required; credited here as a courtesy).

| File | Source asset | Maps kept |
| --- | --- | --- |
| `bark_color.jpg`, `bark_normal.jpg` | [Bark014](https://ambientcg.com/a/Bark014) | Color, NormalGL (1K-JPG) |
| `needles_color.jpg`, `needles_opacity.jpg` | [LeafSet019](https://ambientcg.com/a/LeafSet019) | Color, Opacity (1K-JPG) |
| `plants_color.jpg`, `plants_opacity.jpg` | [Foliage003](https://ambientcg.com/a/Foliage003) | Color, Opacity (1K-JPG) |

Normal maps use the OpenGL (+Y up) convention, which matches Babylon.js.
The opacity maps are grayscale (white = opaque); the vegetation shader reads
their luminance as alpha (alpha-test cutout).

Grass tufts and broadleaf crowns are drawn procedurally at load time (`makeGrassTuft`, `makeLeafClump` in
`src/vegetation/vegetationTextures.ts`); no texture files are needed.
