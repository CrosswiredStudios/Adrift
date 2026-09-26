import { test } from "@playwright/test";

/**
 * Temporary diagnostic: stand ~10 u inland on a flat coast, look down-seaward
 * at the beach strip, and capture three time offsets. Compare with the water
 * cap disabled (margin -999) to see the fix's effect.
 */
test("foam over land A/B (temporary)", async ({ page }) => {
  test.setTimeout(300000);
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[console:error]", m.text());
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => (window as unknown as { __game?: unknown }).__game !== undefined,
    null,
    { timeout: 30000 }
  );

  // Flattest coastal land near the waterline: minimise the max directional
  // derivative over four tangents (true slope, not one arbitrary direction).
  const coast = await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    const probe = (d: number[]) => g.probe(d) as { h: number; water: boolean; waterLevel: number };
    const sun = g.scene.getLightByName("sun").direction.scale(-1);
    const V = g.bodies[0].center.constructor as any;
    let best: { dir: number[]; inland: number[]; grad: number; h: number } | null = null;
    for (let i = 0; i < 40000; i++) {
      const u = (i * 0.6180339887) % 1;
      const v = (i * 0.7548776662) % 1;
      const phi = u * Math.PI * 2;
      const cosT = 1 - 2 * v;
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const d = [sinT * Math.cos(phi), cosT, sinT * Math.sin(phi)];
      if (d[0] * sun.x + d[1] * sun.y + d[2] * sun.z < 0.35) continue;
      const p = probe(d);
      if (p.water || p.h > p.waterLevel + 0.02) continue; // land, within range of the waterline
      const dir = new V(d[0], d[1], d[2]).normalize();
      const ref = new V(Math.abs(dir.y) < 0.9 ? 0 : 1, Math.abs(dir.y) < 0.9 ? 1 : 0, 0);
      const t0 = ref.cross(dir).normalize();
      const t90 = dir.cross(t0).normalize();
      const eps = 0.004;
      let grad = 0;
      let inland: any = t0;
      for (let k = 0; k < 4; k++) {
        const ang = (k * Math.PI) / 2;
        const t = t0.scale(Math.cos(ang)).addInPlace(t90.scale(Math.sin(ang)));
        const hp = probe(dir.add(t.scale(eps)).asArray()).h;
        const hm = probe(dir.subtract(t.scale(eps)).asArray()).h;
        const gd = (hp - hm) / (2 * eps);
        if (Math.abs(gd) > grad) {
          grad = Math.abs(gd);
          inland = gd > 0 ? t : t.scale(-1);
        }
      }
      if (!best || grad < best.grad) best = { dir: dir.asArray(), inland: inland.asArray(), grad, h: p.h };
    }
    return best;
  });
  console.log("coast", JSON.stringify(coast));
  if (!coast) throw new Error("no coast found");

  const place = async (viewAr: number[], aimAr: number[], above: number): Promise<void> => {
    await page.evaluate(
      ([dAr, aAr, alt]) => {
        const g = (window as unknown as { __game: any }).__game;
        const body = g.bodies[0];
        const V = body.center.constructor as new (x: number, y: number, z: number) => any;
        const d = new V(dAr[0], dAr[1], dAr[2]).normalize();
        const a = new V(aAr[0], aAr[1], aAr[2]).normalize();
        const probe = g.probe(d.asArray());
        g.ship.position.copyFrom(body.center).addInPlace(d.scale(probe.seaRadius + alt));
        g.state.landed = false;
        g.state.floating = false;
        g.state.cruise = 0;
        g.state.velocity.set(0, 0, 0);
        const Q = g.ship.rotationQuaternion.constructor as any;
        g.ship.rotationQuaternion.copyFrom(Q.FromLookDirectionLH(a.scale(-1), d));
        for (let i = 0; i < 240; i++) g.step(1 / 60);
      },
      [viewAr, aimAr, above]
    );
  };

  const shot = async (name: string): Promise<void> => {
    await page.waitForTimeout(6000);
    await page.screenshot({ path: `test-results/${name}.png` });
  };

  // Walk inland from the waterline until the ground is ~0.4 u above the water.
  const inlandSpot = await page.evaluate((c) => {
    const g = (window as unknown as { __game: any }).__game;
    const probe = (d: number[]) => g.probe(d) as { h: number; water: boolean; waterLevel: number };
    const V = g.bodies[0].center.constructor as any;
    const dir = new V(c.dir[0], c.dir[1], c.dir[2]).normalize();
    const t = new V(c.inland[0], c.inland[1], c.inland[2]).normalize();
    let d = dir.clone();
    for (let i = 0; i < 40; i++) {
      d = d.addInPlace(t.scale(0.0015)).normalize();
      const p = probe(d.asArray());
      if (p.h > p.waterLevel + 0.015) break;
    }
    return d.asArray() as number[];
  }, coast);

  // Stand inland, look seaward and ~35 deg down so the beach strip is centred.
  const aim = await page.evaluate(
    ([d, l]) => {
      const v = [-l[0] * 0.85 - d[0] * 0.5, -l[1] * 0.85 - d[1] * 0.5, -l[2] * 0.85 - d[2] * 0.5];
      const l2 = Math.hypot(v[0], v[1], v[2]) || 1;
      return [v[0] / l2, v[1] / l2, v[2] / l2];
    },
    [inlandSpot, coast.inland]
  );

  await place(inlandSpot, aim, 22);

  const survey = await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    const probe = (d: number[]) => g.probe(d) as { h: number; water: boolean; waterLevel: number };
    const V = g.bodies[0].center.constructor as any;
    const dir = g.ship.position.subtract(g.bodies[0].center).normalize();
    const ref = new V(Math.abs(dir.y) < 0.9 ? 0 : 1, Math.abs(dir.y) < 0.9 ? 1 : 0, 0);
    const tA = ref.cross(dir).normalize();
    const tB = dir.cross(tA).normalize();
    let water = 0;
    let land = 0;
    const rows: string[] = [];
    for (let j = -6; j <= 6; j++) {
      let row = "";
      for (let i = -6; i <= 6; i++) {
        const d = dir.add(tA.scale(i * 0.0032)).add(tB.scale(j * 0.0032)).normalize();
        const p = probe(d.asArray());
        if (p.water) { water++; row += "~"; } else { land++; row += "#"; }
      }
      rows.push(row);
    }
    return { water, land, rows };
  });
  console.log("survey around ship", JSON.stringify(survey));

  await shot("foam-inland-a");
  await page.waitForTimeout(4000);
  await page.screenshot({ path: "test-results/foam-inland-b.png" });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: "test-results/foam-inland-c.png" });

  // Same view with the ocean meshes hidden: separates ocean-sheet water/foam
  // from the ground-shader wet band.
  const hidden = await page.evaluate(() => {
    const g = (window as unknown as { __game: any }).__game;
    const names: string[] = [];
    for (const mesh of g.scene.meshes) {
      if (/ocean|-water/.test(mesh.name)) {
        mesh.visibility = 0;
        names.push(mesh.name);
      }
    }
    return names;
  });
  console.log("hidden meshes", JSON.stringify(hidden));
  await page.waitForTimeout(6000);
  await page.screenshot({ path: "test-results/foam-inland-noocean.png" });
});
