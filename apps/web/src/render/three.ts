/**
 * The Three.js binding — the only file in `apps/web` that knows what a GPU is.
 *
 * Everything the renderer *decides* was decided before this file runs: which
 * meshes exist (`classify`), where each instance is this frame (`frame`), what
 * the camera is looking at (`camera`), and how much fidelity the device has
 * earned (`quality`). This module only uploads that. The split is what lets 09
 * §4's draw-call claim be a `node:test` assertion rather than a screenshot, and
 * it is why `buildInstancedMeshes` is exercised headlessly: constructing Three
 * objects needs no WebGL context, so the binding's structure — one
 * `InstancedMesh` per plan mesh, one instance per plan instance — is checked
 * without a browser. Only `WebGLRenderer` needs a canvas, and it lives in P3c's
 * React shell.
 *
 * Materials are **flat colors on purpose**. 04 §12.3: the skin *names* are
 * normative, "the picker shows swatches once M8 defines materials — until then,
 * flat colors". Shipping a guess at `brass` would be the art pass done badly and
 * invisibly; this is the art pass deferred visibly (U11).
 *
 * Contract: docs/09-PERFORMANCE.md §4; docs/04-BUILDER-UX.md §4, §12.3;
 * ADR-0003 (Three.js).
 */

import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
} from 'three';
import { SKIN_NAMES, type SkinName } from '../editor/model.js';
import { EDITOR } from '../editor/model.js';
import type { InstanceMesh, InstancePrimitive, RenderPlan } from './classify.js';
import { cameraBasis, eyePosition, viewRollDeg, type CameraState, type Viewport } from './camera.js';
import type { DrawnInstance, FrameBuffer } from './frame.js';
import { RENDER } from './perf.js';
import type { RenderEnvelope } from './quality.js';

/**
 * Placeholder palette — one flat color per skin (04 §12.3, U11).
 *
 * Chosen only to be distinguishable from each other at a glance, which is the
 * job a swatch has to do before the materials exist.
 */
export const SKIN_COLORS = {
  wood: 0xb07a44,
  steel: 0x9aa3ab,
  brass: 0xc9a227,
  stone: 0x8b8b86,
  glass: 0x9fd8e8,
  rubber: 0x3a3a3f,
  neon: 0x3df2c1,
  candy: 0xf2578b,
} as const satisfies Record<SkinName, number>;

/** The three unit meshes 09 §4 names, at unit scale so per-instance scale is the size. */
export function unitGeometry(primitive: InstancePrimitive): BufferGeometry {
  switch (primitive) {
    case 'box':
      return new BoxGeometry(1, 1, 1);
    case 'sphere':
      return new SphereGeometry(1, 16, 12);
    case 'disc':
      // A cylinder stands along Y by default; the board's out-of-plane axis is
      // Z, so it is laid down once here rather than per instance.
      return new CylinderGeometry(1, 1, 1, 24).rotateX(Math.PI / 2);
  }
}

export interface MeshBinding {
  key: string;
  mesh: InstancedMesh;
  /** Plan instances in the same order as the mesh's instance ids. */
  offset: number;
  count: number;
}

export interface SceneBinding {
  root: Group;
  bindings: MeshBinding[];
  dispose(): void;
}

/**
 * Build one `InstancedMesh` per plan mesh.
 *
 * `offset` records where this mesh's instances start in the flat frame buffer,
 * because `applyFrame` writes one array in plan order — so the upload is a
 * contiguous slice per mesh with no per-instance lookup.
 */
export function buildInstancedMeshes(plan: RenderPlan): SceneBinding {
  const root = new Group();
  root.name = 'instanced';
  const bindings: MeshBinding[] = [];
  const geometries: BufferGeometry[] = [];
  const materials: MeshStandardMaterial[] = [];
  let offset = 0;
  for (const planMesh of plan.meshes) {
    const geometry = unitGeometry(planMesh.primitive);
    const material = new MeshStandardMaterial({ color: SKIN_COLORS[planMesh.skin] });
    const mesh = new InstancedMesh(geometry, material, planMesh.instances.length);
    mesh.name = planMesh.key;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = true;
    geometries.push(geometry);
    materials.push(material);
    root.add(mesh);
    bindings.push({ key: planMesh.key, mesh, offset, count: planMesh.instances.length });
    offset += planMesh.instances.length;
  }
  return {
    root,
    bindings,
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      root.clear();
    },
  };
}

const SCRATCH_MATRIX = new Matrix4();
const SCRATCH_POS = new Vector3();
const SCRATCH_QUAT = new Quaternion();
const SCRATCH_SCALE = new Vector3();
const SCRATCH_AXIS = new Vector3(0, 0, 1);
const SCRATCH_COLOR = new Color();

/** Per-instance scale for a primitive: a unit mesh times the collider's size. */
function scaleOf(planMesh: InstanceMesh, index: number): Vector3 {
  const inst = planMesh.instances[index];
  if (!inst) return SCRATCH_SCALE.set(1, 1, 1);
  switch (planMesh.primitive) {
    case 'box':
      return SCRATCH_SCALE.set(inst.hx * 2, inst.hy * 2, RENDER.EXTRUDE_DEPTH_M);
    case 'sphere':
      return SCRATCH_SCALE.set(inst.r, inst.r, inst.r);
    case 'disc':
      return SCRATCH_SCALE.set(inst.r, inst.r, RENDER.EXTRUDE_DEPTH_M);
  }
}

/**
 * Push one frame's poses into the GPU buffers.
 *
 * A hidden instance (`Removed`, 04 §10.3) is scaled to zero rather than removed
 * from the mesh: `InstancedMesh` has no per-instance visibility, and rebuilding
 * the buffer to close the gap would make removal cost O(bodies) at exactly the
 * moment a machine is busiest.
 */
export function uploadFrame(binding: SceneBinding, plan: RenderPlan, buf: FrameBuffer, envelope: RenderEnvelope): void {
  for (let m = 0; m < binding.bindings.length; m++) {
    const bind = binding.bindings[m] as MeshBinding;
    const planMesh = plan.meshes[m] as InstanceMesh;
    for (let i = 0; i < bind.count; i++) {
      const drawn = buf.drawn[bind.offset + i] as DrawnInstance;
      SCRATCH_POS.set(drawn.x, drawn.y, 0);
      SCRATCH_QUAT.setFromAxisAngle(SCRATCH_AXIS, drawn.rot);
      const scale = scaleOf(planMesh, i);
      if (!drawn.visible) scale.set(0, 0, 0);
      SCRATCH_MATRIX.compose(SCRATCH_POS, SCRATCH_QUAT, scale);
      bind.mesh.setMatrixAt(i, SCRATCH_MATRIX);
      // Sleep dimming rides on the instance color (09 §4): one multiply, no
      // second material and therefore no second draw call.
      SCRATCH_COLOR.setHex(SKIN_COLORS[planMesh.skin]);
      if (drawn.dim !== 1) SCRATCH_COLOR.multiplyScalar(drawn.dim);
      if (drawn.saturation !== 1) {
        // Toward the grey of the same luminance, by however much saturation was
        // taken away (04 §10.3's "~15%").
        const grey = SCRATCH_COLOR.r * 0.2126 + SCRATCH_COLOR.g * 0.7152 + SCRATCH_COLOR.b * 0.0722;
        const k = 1 - drawn.saturation;
        SCRATCH_COLOR.setRGB(
          SCRATCH_COLOR.r + (grey - SCRATCH_COLOR.r) * k,
          SCRATCH_COLOR.g + (grey - SCRATCH_COLOR.g) * k,
          SCRATCH_COLOR.b + (grey - SCRATCH_COLOR.b) * k,
        );
      }
      bind.mesh.setColorAt(i, SCRATCH_COLOR);
    }
    bind.mesh.instanceMatrix.needsUpdate = true;
    if (bind.mesh.instanceColor) bind.mesh.instanceColor.needsUpdate = true;
    bind.mesh.castShadow = envelope.shadows;
    bind.mesh.receiveShadow = envelope.shadows;
  }
}

/**
 * Drive a `PerspectiveCamera` from the 04 §4 rig.
 *
 * The plane-angle roll is applied to the camera's `up` vector rather than to the
 * scene: rolling the world would move every object's coordinates away from the
 * board frame the cursor readout and the inspector report in (04 §4, "cursor
 * coordinates are always board-frame").
 */
export function applyCamera(
  camera: PerspectiveCamera,
  cam: CameraState,
  viewport: Viewport,
  planeAngleDeg: number,
): void {
  const eye = eyePosition(cam);
  camera.fov = EDITOR.CAMERA_FOV_DEG;
  camera.aspect = viewport.widthPx / Math.max(1, viewport.heightPx);
  camera.position.set(eye[0], eye[1], eye[2]);
  const { up, forward } = cameraBasis(cam);
  const roll = viewRollDeg(planeAngleDeg) * (Math.PI / 180);
  const axis = new Vector3(forward[0], forward[1], forward[2]).normalize();
  camera.up.copy(new Vector3(up[0], up[1], up[2]).applyAxisAngle(axis, roll));
  camera.lookAt(cam.target[0], cam.target[1], 0);
  camera.updateProjectionMatrix();
}

/** Every skin has a placeholder color — checked here so a new skin cannot ship colorless. */
export const SKIN_COLOR_COVERAGE = SKIN_NAMES.every((s) => s in SKIN_COLORS);
