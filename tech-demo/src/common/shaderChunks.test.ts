import { describe, expect, it } from "vitest";
import { Color3 } from "@babylonjs/core";
import { glslColor, glslNum, skyGLSL } from "./shaderChunks";

describe("glslNum", () => {
  it("always keeps a decimal point for GLSL floats", () => {
    expect(glslNum(1)).toBe("1.000000");
    expect(glslNum(0.5)).toBe("0.500000");
    expect(glslNum(-2.25)).toBe("-2.250000");
  });
});

describe("glslColor", () => {
  it("formats a vec3 constructor", () => {
    expect(glslColor(new Color3(0.1, 0.2, 0.3))).toBe(
      `vec3(${glslNum(0.1)}, ${glslNum(0.2)}, ${glslNum(0.3)})`,
    );
  });
});

describe("skyGLSL", () => {
  it("bakes the palette into the shader source", () => {
    const src = skyGLSL({
      skyTint: new Color3(0.2, 0.4, 0.8),
      skyStrength: 0.5,
      hazeTint: new Color3(0.9, 0.8, 0.7),
      hazeStrength: 0.3,
      hazeG: 0.85,
      sunTint: new Color3(1, 0.9, 0.8),
      sunGlow: 0.7,
    });
    expect(src).toContain("SKY_TINT");
    expect(src).toContain(glslColor(new Color3(0.2, 0.4, 0.8)));
    expect(src).toContain("skyColor");
  });
});
