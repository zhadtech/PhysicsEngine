/**
 * The per-frame read — 03 §5.5's interpolation contract, applied to a render plan.
 *
 * 04 §10.3: "Renderer follows the 03 §5.5 interpolation contract **exactly**
 * (playhead clamp, shortest-arc angle lerp)." The way to follow a contract
 * exactly is not to re-implement it: `advancePlayhead`, `sampleAt` and
 * `lerpAngle` are the engine's own functions, shipped at P2c and already pinned
 * by its unit suite and by the browser golden legs. This module imports them
 * from `@physics/engine/transport` — a Rapier-free entry point, because the one
 * thread that must never load a physics build is the one drawing at 60 Hz — and
 * adds only what the *picture* needs on top:
 *
 *   - composing each collider's body-local offset onto the body pose;
 *   - the three `BodyState` cases (04 §10.3, 09 §4): `Removed` hides the
 *     instance, `Asleep` dims and desaturates it, `Awake` draws it plainly;
 *   - the distance LOD bucket, capped by the device tier (09 §4, §7).
 *
 * Contract: docs/03-SIMULATION-CORE.md §5.5; docs/04-BUILDER-UX.md §10.3;
 * docs/09-PERFORMANCE.md §4.
 */

import type { Vec2 } from '@physics/scene-format';
import { BodyState, SAB } from '@physics/engine/protocol';
import { dcos, dsin } from '@physics/engine/geometry';
import type { Instance, RenderPlan } from './classify.js';
import { RENDER, type DeviceTier } from './perf.js';

/** What one instance looks like this frame. */
export interface DrawnInstance {
  x: number;
  y: number;
  rot: number;
  /** `Removed` bodies leave the picture (04 §10.3 draws a poof at the last pose). */
  visible: boolean;
  /** Brightness multiplier: 1 awake, `SLEEP_DIM_FACTOR` asleep. */
  dim: number;
  /** Saturation multiplier — 04 §10.3's "desaturates ~15%". */
  saturation: number;
  /** 0 imposter … 2 full mesh, already clamped to the tier's ceiling. */
  lod: 0 | 1 | 2;
  /** True on the frame a body first reads `Removed` — the poof trigger. */
  justRemoved: boolean;
}

/** Reusable per-frame output, sized once from the plan. */
export interface FrameBuffer {
  drawn: DrawnInstance[];
  instances: Instance[];
}

export function makeFrameBuffer(instances: Instance[]): FrameBuffer {
  return {
    instances,
    drawn: instances.map(() => ({
      x: 0,
      y: 0,
      rot: 0,
      visible: true,
      dim: 1,
      saturation: 1,
      lod: 2 as const,
      justRemoved: false,
    })),
  };
}

/**
 * Distance LOD (09 §4): full mesh inside `LOD_NEAR_M`, imposter past
 * `LOD_FAR_M`, one step between. The tier ceiling is applied here rather than at
 * draw time so that `low` (`maxInstanceDetailLod: 0`) genuinely never asks for a
 * beveled mesh — a cap applied later would still have built one.
 */
export function lodFor(distanceM: number, tier: DeviceTier): 0 | 1 | 2 {
  const raw: 0 | 1 | 2 = distanceM <= RENDER.LOD_NEAR_M ? 2 : distanceM >= RENDER.LOD_FAR_M ? 0 : 1;
  return Math.min(raw, tier.maxInstanceDetailLod) as 0 | 1 | 2;
}

/**
 * Write one frame's poses into `buf`.
 *
 * `floats` is a sampled frame — `bodyCount × FLOATS_PER_BODY` of `[x, y, rot,
 * state]`, exactly the SAB slot layout (03 §5.4), whether it came from shared
 * memory or the postMessage fallback. Static instances are not in it at all and
 * keep the pose §6 gave them, which is 03 §5.3's "static geometry is not sent"
 * showing up as an absence rather than as a special case.
 */
export function applyFrame(buf: FrameBuffer, floats: Float32Array | null, cameraTarget: Vec2, tier: DeviceTier): void {
  const { instances, drawn } = buf;
  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i] as Instance;
    const out = drawn[i] as DrawnInstance;
    let bx: number;
    let by: number;
    let brot: number;
    let state: number = BodyState.Awake;

    if (inst.pose !== null) {
      bx = inst.pose.pos[0];
      by = inst.pose.pos[1];
      brot = inst.pose.rot;
      // A static instance already carries its collider offset in world space;
      // re-composing would apply it twice.
      out.x = bx;
      out.y = by;
      out.rot = brot;
    } else if (floats === null || inst.slot < 0) {
      // Nothing published yet (§5.5 "sampling before the first publish"), or an
      // unbound instance: leave it where it was and hide it rather than drawing
      // a body at the origin.
      out.visible = false;
      out.justRemoved = false;
      continue;
    } else {
      const base = inst.slot * SAB.FLOATS_PER_BODY;
      bx = floats[base] ?? 0;
      by = floats[base + 1] ?? 0;
      brot = floats[base + 2] ?? 0;
      state = floats[base + 3] ?? BodyState.Awake;
      const c = dcos(brot);
      const s = dsin(brot);
      out.x = bx + inst.offset[0] * c - inst.offset[1] * s;
      out.y = by + inst.offset[0] * s + inst.offset[1] * c;
      out.rot = brot + inst.offsetRot;
    }

    const removed = state === BodyState.Removed;
    out.justRemoved = removed && out.visible;
    out.visible = !removed;
    const asleep = state === BodyState.Asleep;
    out.dim = asleep ? RENDER.SLEEP_DIM_FACTOR : 1;
    out.saturation = asleep ? 1 - RENDER.SLEEP_DESATURATE : 1;
    const dx = out.x - cameraTarget[0];
    const dy = out.y - cameraTarget[1];
    out.lod = lodFor(Math.sqrt(dx * dx + dy * dy), tier);
  }
}

/**
 * How many instances a frame actually draws — awake, asleep and hidden.
 *
 * 09 §3's whole cost law is that the *awake* set is what matters, and 04 §10.3's
 * debug overlay reports "body count awake/asleep"; both read this.
 */
export function frameStats(buf: FrameBuffer): { awake: number; asleep: number; hidden: number } {
  let awake = 0;
  let asleep = 0;
  let hidden = 0;
  for (const d of buf.drawn) {
    if (!d.visible) hidden++;
    else if (d.dim === RENDER.SLEEP_DIM_FACTOR) asleep++;
    else awake++;
  }
  return { awake, asleep, hidden };
}

/** Instances the plan expects to be driven by the buffer — the count `bindRegistry` must cover. */
export function dynamicInstanceCount(plan: RenderPlan): number {
  let n = 0;
  for (const mesh of plan.meshes) for (const inst of mesh.instances) if (inst.pose === null) n++;
  return n;
}
