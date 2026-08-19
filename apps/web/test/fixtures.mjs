// A scene with one of everything the editor's reference graph can reach:
// links whose endpoints may be deleted, a trigger with targets, a goal with an
// explicit accepts list, a rope routed over a pulley. Small enough to reason
// about by hand, complete enough that a cascade bug has somewhere to hide.

export function fixtureScene() {
  return {
    schemaVersion: 1,
    engineVersion: '0.1.0',
    meta: { title: 'Cascade fixture' },
    world: { seed: 7 },
    objects: [
      { id: 'floor', type: 'platform', pos: [0, -0.025], props: { w: 3 } },
      { id: 'rmp', type: 'ramp', pos: [-1.1, 0.15], props: { w: 0.6, h: 0.3 } },
      { id: 'mar1', type: 'marble', pos: [-1.35, 0.34] },
      { id: 'dom1', type: 'domino', pos: [-0.6, 0] },
      { id: 'dom2', type: 'domino', pos: [-0.54, 0] },
      { id: 'gear1', type: 'gear', pos: [0.4, 0.3], props: { r: 0.1 } },
      { id: 'gear2', type: 'gear', pos: [0.6, 0.3], props: { r: 0.1 } },
      { id: 'pul1', type: 'pulley', pos: [0.9, 0.8] },
      { id: 'cra1', type: 'crate', pos: [0.9, 0.2] },
      { id: 'fan1', type: 'fan', pos: [1.2, 0.3] },
      { id: 'tri1', type: 'trigger', pos: [0.1, 0.05], props: { targets: ['fan1', 'gear1'] } },
      { id: 'goal1', type: 'goal', pos: [1.4, 0.05], props: { accepts: ['mar1', 'cra1'] } },
    ],
    links: [
      { id: 'mesh1', type: 'gearMesh', a: { obj: 'gear1' }, b: { obj: 'gear2' } },
      { id: 'rope1', type: 'rope', a: { obj: 'cra1' }, b: { obj: 'floor', anchor: 'top' }, props: { via: ['pul1'] } },
      { id: 'weld1', type: 'weld', a: { obj: 'dom1' }, b: { obj: 'dom2' } },
    ],
  };
}

/** A flat floor with nothing on it — the seat-cast fixture. */
export function floorScene() {
  return {
    schemaVersion: 1,
    engineVersion: '0.1.0',
    world: {},
    objects: [{ id: 'floor', type: 'platform', pos: [0, 0], props: { w: 4, h: 0.1 } }],
  };
}

/** Deep structural equality that also compares key *order* within objects. */
export function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
