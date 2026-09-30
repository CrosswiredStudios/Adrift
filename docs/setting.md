# Adrift — Setting & Planets

## System: Vesper Drift

A small system with a star, two planets, and one large moon. It is built
**miniature** (1 unit = 1 m, planets a few kilometres across with real surface
gravity) so walking, suborbital hops and interplanetary flights all take
minutes. Exact numbers live in `tech-demo/src/data/system.ts`:

| Body | Radius | Gravity | Orbit | Day |
| --- | --- | --- | --- | --- |
| Vesper (star) | 8 km | — | — | — |
| Vael | 2 km | 9.81 m/s² | 300 km from the star | 20 min |
| Tethys (moon) | 600 m | 1.62 m/s² | 12 km from Vael | tidally locked |
| Cinder | 1.5 km | 7.4 m/s² | 480 km from the star | 30 min |

> **Naming, to decide:** earlier drafts call the star "Sol"; the demo uses
> **Vesper** (after the system) to avoid confusion with our Sun. The second
> planet is "Cinder" in the demo; "Pelagos" is the alternative.

### Vael (starting planet)

- Temperate ruin world with breathable valleys, thin highlands.
- Ruined cities, terraces, and a crashed-ship tutorial zone.
- Atmosphere: nitrogen-oxygen, blue scattering, warm sunsets.

### Tethys (moon)

- Airless grey body where the collision happened.
- Debris field with high-tier salvage and low gravity.
- No atmosphere; harsh sun and black sky.

### Cinder (second planet; alt. name Pelagos)

- Volcanic and ocean biomes; source of heat-shield materials.
- Dense orange haze; strong scattering and high drag.
- Holds relay station needed for rescue beacon.

### Ruins Language

- Circular glyphs; each discovery teaches words.
- Monoliths project star maps pointing to relay sites.

## Art Direction

- Realistic scale cues with stylized emissive glyphs.
- Transitions: dark space → thin blue line → bright sky.
- Night ruins glow faintly; beacons visible from orbit.
