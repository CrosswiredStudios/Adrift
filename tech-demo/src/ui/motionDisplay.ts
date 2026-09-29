/**
 * Ship motion display: the ship's velocity relative to the ground, broken
 * down along the ship's own axes, plus which thruster banks are firing.
 *
 *  - Drift pad (left): sideways (left/right) and vertical (up/down) velocity
 *    as a vector from the centre. Rings mark 1, 10 and 100 m/s.
 *  - Speed tape (middle): forward/back velocity as a bar from the zero line.
 *  - Readouts (right): each axis as a direction letter and m/s.
 *  - Wedges on the pad rim and tape ends light up with the thrust on that
 *    axis, so you can see a burn cancelling the drift.
 *
 * Velocities use a log scale so a 0.5 m/s drift before touchdown and a
 * 300 m/s cruise are both readable. Drawn on a small 2D canvas each frame.
 */

export interface MotionModel {
  /** Velocity relative to the body's surface frame, in ship axes (x right, y up, z forward), m/s. */
  vel: [number, number, number];
  /** Thruster output per ship axis, -1..1. */
  thrust: [number, number, number];
  /** Body the velocity is measured against (e.g. "Vael"). */
  relativeTo: string;
}

/** Full-scale speed of the display (m/s). */
export const MOTION_FULL_SCALE = 300;
/** Below this on every axis the ship reads as matched (m/s). */
export const MOTION_MATCHED = 0.15;

/** Signed log mapping of a speed to -1..1 (1 m/s ~ 0.12, 10 ~ 0.42, 100 ~ 0.81). */
export function motionScale(v: number): number {
  const s = Math.log1p(Math.abs(v)) / Math.log1p(MOTION_FULL_SCALE);
  return Math.sign(v) * Math.min(1, s);
}

/** Axis readout: direction letter + magnitude, e.g. "F  120.4" or "L    3.2". */
export function axisReadout(v: number, pos: string, neg: string): string {
  const a = Math.abs(v);
  const letter = a < 0.05 ? " " : v > 0 ? pos : neg;
  const num = a >= 100 ? a.toFixed(0) : a.toFixed(1);
  return `${letter} ${num.padStart(6)}`;
}

const W = 272;
const H = 150;
const PAD = { x: 72, y: 72, r: 60 };
const TAPE = { x: 160, w: 16, top: 14, bottom: 130 };
const COL = {
  grid: "rgba(207, 232, 255, 0.22)",
  gridStrong: "rgba(207, 232, 255, 0.45)",
  text: "#cfe8ff",
  dim: "rgba(207, 232, 255, 0.55)",
  vel: "#7fd0ff",
  thrust: "#ffb060",
  matched: "#8cffb0",
};

export class MotionDisplay {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private dpr = 1;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "hud-motion";
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
  }

  setVisible(on: boolean): void {
    this.canvas.classList.toggle("visible", on);
  }

  draw(m: MotionModel): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (dpr !== this.dpr || this.canvas.width !== Math.round(W * dpr)) {
      this.dpr = dpr;
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const [vx, vy, vz] = m.vel;
    const [tx, ty, tz] = m.thrust;
    const matched = Math.max(Math.abs(vx), Math.abs(vy), Math.abs(vz)) < MOTION_MATCHED;

    // --- Drift pad: rings at 1, 10, 100 m/s and the full-scale rim.
    ctx.lineWidth = 1;
    for (const v of [1, 10, 100]) {
      ctx.strokeStyle = COL.grid;
      ctx.beginPath();
      ctx.arc(PAD.x, PAD.y, motionScale(v) * PAD.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = COL.gridStrong;
    ctx.beginPath();
    ctx.arc(PAD.x, PAD.y, PAD.r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = COL.grid;
    ctx.beginPath();
    ctx.moveTo(PAD.x - PAD.r, PAD.y);
    ctx.lineTo(PAD.x + PAD.r, PAD.y);
    ctx.moveTo(PAD.x, PAD.y - PAD.r);
    ctx.lineTo(PAD.x, PAD.y + PAD.r);
    ctx.stroke();

    // Thrust wedges on the rim (right, left, up, down).
    wedge(ctx, PAD.x + PAD.r + 2, PAD.y, 0, Math.max(0, tx));
    wedge(ctx, PAD.x - PAD.r - 2, PAD.y, Math.PI, Math.max(0, -tx));
    wedge(ctx, PAD.x, PAD.y - PAD.r - 2, -Math.PI / 2, Math.max(0, ty));
    wedge(ctx, PAD.x, PAD.y + PAD.r + 2, Math.PI / 2, Math.max(0, -ty));

    // Drift vector (screen y is down).
    const planar = Math.hypot(vx, vy);
    const pr = motionScale(planar) * PAD.r;
    const dx = planar > 1e-6 ? (vx / planar) * pr : 0;
    const dy = planar > 1e-6 ? (-vy / planar) * pr : 0;
    const colour = matched ? COL.matched : COL.vel;
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PAD.x, PAD.y);
    ctx.lineTo(PAD.x + dx, PAD.y + dy);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(PAD.x + dx, PAD.y + dy, 4, 0, Math.PI * 2);
    ctx.fill();

    // --- Speed tape (forward up, back down).
    const mid = (TAPE.top + TAPE.bottom) / 2;
    const half = (TAPE.bottom - TAPE.top) / 2;
    ctx.strokeStyle = COL.gridStrong;
    ctx.lineWidth = 1;
    ctx.strokeRect(TAPE.x + 0.5, TAPE.top + 0.5, TAPE.w, TAPE.bottom - TAPE.top);
    ctx.strokeStyle = COL.grid;
    ctx.beginPath();
    for (const v of [1, 10, 100]) {
      for (const sgn of [1, -1]) {
        const y = mid - sgn * motionScale(v) * half;
        ctx.moveTo(TAPE.x, y + 0.5);
        ctx.lineTo(TAPE.x + TAPE.w + 1, y + 0.5);
      }
    }
    ctx.stroke();
    const zh = motionScale(vz) * half;
    ctx.fillStyle = colour;
    ctx.fillRect(TAPE.x + 3, Math.min(mid, mid - zh), TAPE.w - 5, Math.max(2, Math.abs(zh)));
    ctx.strokeStyle = COL.gridStrong;
    ctx.beginPath();
    ctx.moveTo(TAPE.x - 3, mid + 0.5);
    ctx.lineTo(TAPE.x + TAPE.w + 4, mid + 0.5);
    ctx.stroke();
    wedge(ctx, TAPE.x + TAPE.w / 2 + 0.5, TAPE.top - 3, -Math.PI / 2, Math.max(0, tz));
    wedge(ctx, TAPE.x + TAPE.w / 2 + 0.5, TAPE.bottom + 4, Math.PI / 2, Math.max(0, -tz));

    // --- Readouts.
    ctx.font = "12px monospace";
    ctx.textBaseline = "middle";
    const rx = 190;
    const rows: [string, string, number][] = [
      ["fwd/back", axisReadout(vz, "F", "B"), 30],
      ["side", axisReadout(vx, "R", "L"), 66],
      ["up/down", axisReadout(vy, "U", "D"), 102],
    ];
    for (const [label, value, y] of rows) {
      ctx.fillStyle = COL.dim;
      ctx.fillText(label, rx, y - 9);
      ctx.fillStyle = COL.text;
      ctx.fillText(value, rx, y + 6);
    }
    ctx.fillStyle = matched ? COL.matched : COL.dim;
    ctx.fillText(matched ? "MATCHED" : `rel ${m.relativeTo}`, rx, 136);
  }
}

/** Small triangle pointing along `angle`, lit by `amount` (0..1). */
function wedge(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, amount: number): void {
  const a = Math.min(1, amount);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(8, 0);
  ctx.lineTo(0, -6);
  ctx.lineTo(0, 6);
  ctx.closePath();
  if (a > 0.03) {
    ctx.globalAlpha = 0.35 + 0.65 * a;
    ctx.fillStyle = COL.thrust;
    ctx.fill();
  } else {
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
}
