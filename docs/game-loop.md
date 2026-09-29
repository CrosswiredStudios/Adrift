# Adrift — Core Loop & Systems

## Core Loop

Explore ruins → Discover data → Unlock crafting → Upgrade suit and ship → Reach new biomes and planets → Discover rescue tech → Signal and escape.

## Systems

Status in the tech demo: **[done]** implemented, **[partial]** started,
unmarked = design only.

### Exploration

- **[done]** Points of interest: ruins, crash debris, monoliths (caves: design only).
- **[done]** Scanning reveals lore fragments; discoveries gate recipes.
- **[partial]** Day/night and clouds are simulated; hazards are not yet.

### Survival

- Oxygen, power, thermal, health (HUD slots exist; not simulated yet).
- Harvest ice, metals, flora for fuel and repairs.
- Shelters and beacons extend range.

### Crafting & Ship Building

- **[partial]** Tiers: Salvage → Field repairs → Skiff (suborbital) → Starhopper (interplanetary). The demo has salvage, a hull-patch field repair and the relay key; the skiff is pre-built and can already reach every body.
- Ship modules: thruster, tank, nav core, heat shield, beacon amplifier.
- Discoveries gate recipes, not just resources.

### Flight

- **[done]** Newtonian model with real gravity wells and orbits, atmospheric drag and heating.
- **[partial]** Flight assist: rate-command rotation, auto-level, hover, gentle-descent landing (collision warning: not yet).
- **[done]** Seamless scale: floating origin + logarithmic depth, bodies on rails, sphere-of-influence hand-off.

### Narrative & Discovery

- The civilization vanished mid-experiment with orbital gates.
- Glyph language learned progressively; translates UI and lore.
- Endings: rescue signal answered, self-rescue jump, or stay as keeper.

## Progression Gates

(The demo's objective chain is a compressed version of these; see
`tech-demo/src/data/content.ts`.)

1. Survive first night.
2. Restore pod power.
3. Build skiff, reach moon debris field.
4. Build starhopper, visit second planet.
5. Activate relay network, send rescue call.
