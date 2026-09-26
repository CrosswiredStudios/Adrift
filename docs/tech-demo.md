# Adrift Tech Demo — Seamless Spaceflight

Goal: fly seamlessly from a planet surface to orbit to another planet in Babylon.js.

## Controls

- `W/S`: main thrust forward/back.
- `Shift`: boost.
- `Mouse drag` or arrows: pitch/yaw.
- `A/D`: roll/strafe.
- `L`: toggle landing assist readout.
- `1/2`: target Vael Prime / Tethys.

## What It Proves

- One continuous scene, no teleports.
- Scale strategy: real units with camera far plane management.
- Atmospheric scattering: fresnel shell + sky color lerp by altitude.
- Gravity wells bend trajectory near bodies.
- HUD shows speed, altitude, target distance.

## Structure

- `tech-demo/src/main.ts`: scene setup.
- `tech-demo/src/flight.ts`: ship controller.
- `tech-demo/src/planets.ts`: bodies, atmospheres, sky transition.
- `tech-demo/src/hud.ts`: overlay readouts.

## Run

```powershell
cd tech-demo
npm install
npm run dev
```
