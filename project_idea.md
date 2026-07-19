# Project Idea: Physics Sandbox Platform

Build a web-based physics sandbox where users can create, simulate, and share chain-reaction machines (e.g., domino runs, marble tracks, gears, levers, pendulums, ramps, springs, pulleys, conveyors, etc.).

## Core Concept

The platform should run all physics simulations locally in the user's browser (using technologies such as WebAssembly/WebGPU/Web Workers), while the backend is responsible only for user accounts, persistence, search, sharing, likes, comments, and leaderboards. No server-side physics simulation should be required.

## Main Features

### Builder

* Drag-and-drop object placement.
* Move, rotate, duplicate, delete objects.
* Snap/grid support.
* Adjustable physics properties (mass, friction, restitution, motor speed, etc.).
* Multiple object types:

  * Dominoes
  * Marbles
  * Ramps
  * Gears
  * Levers
  * Springs
  * Pendulums
  * Pistons
  * Conveyors
  * Fans
  * Magnets
  * Rope/Pulleys
  * Other modular physics components

### Simulation

* One-click Play/Pause/Reset.
* Real-time physics simulation.
* Deterministic behavior given the same scene and seed.
* Fast enough to support thousands of objects.
* Simulation runs entirely on the client.

### Save & Share

Scenes should be stored as compact JSON describing object types, transforms, and properties rather than simulation results.

Users can:

* Save creations
* Share via URL
* Clone/remix existing creations
* Browse public creations

### Procedural Generation

Allow users to generate new machines using parameters such as:

* Random seed (timestamp or custom seed)
* Desired simulation duration
* Number of objects
* Object types
* Difficulty/complexity
* Plane angle
* Theme
* Chaos/randomness level
* Desired number of chain reactions

The generated machine should satisfy the requested constraints as closely as possible.

### AI Generation

Allow natural-language prompts such as:

* "Build a 60-second marble run."
* "Create a satisfying domino spiral."
* "Generate a complex Rube Goldberg machine with three major chain reactions."

The AI should output scene JSON rather than images.

### Analytics

After each simulation, compute metrics such as:

* Total simulation duration
* Number of objects activated
* Chain reaction count
* Maximum speed
* Longest collision chain
* Success/failure
* Efficiency score

### Community

* Public gallery
* Likes
* Comments
* Following creators
* Trending builds
* Weekly challenges
* Leaderboards
* Remix functionality

## Technical Goals

* Browser-first architecture.
* Client-side physics engine (e.g., Rapier WASM).
* Responsive even with large scenes.
* Scalable backend because physics computation is offloaded to users' devices.
* Scene format should be versioned and extensible.

## Deliverable

Design a complete product specification, including:

1. System architecture
2. Technology stack recommendations
3. Scene data model
4. Physics engine choice and rationale
5. UI/UX wireframes
6. Database schema
7. API design
8. Procedural generation algorithm
9. AI generation pipeline
10. Performance optimization strategies
11. Multiplayer/collaboration roadmap
12. Monetization ideas
13. Development roadmap from MVP to production

The goal is to build a platform that combines the creativity of Minecraft, the physics of Besiege, the satisfaction of Rube Goldberg machines, and the community-driven sharing model of YouTube or Roblox.
