# ZiPlayer repository guide for coding agents

Read the root [`README.md`](README.md) for public setup and player workflows. For core API use and internal architecture, read
[`core/AGENTS.md`](core/AGENTS.md). The core package's agent guide is included in the published `ziplayer` package.

## Repository structure

- `core/src/` contains the player facade, manager, controllers, stream handling, output backends, and public exports. Edit source
  here; `core/dist/` is generated.
- `plugins/`, `extension/`, `infinity/`, and `adapters/` are separate integration packages.
- `client/` is the dependency-free browser PCM receiver package. Keep its browser entry free of Node.js APIs.
- `examples/backend/` is the runnable ZiPlayer + authenticated WebSocket gateway + browser playback example.
- `docs/` contains implementation/API references, including the audio output contract.
- `tests/` contains core regression tests; each package can also provide focused tests.

## User-facing behavior

- Normal applications should use `PlayerManager`, `Player`, plugins, and documented player options, not private Bus/controller
  internals.
- Discord Voice remains the default output. Custom output is selected per player through `audioOutputBackendFactory`.
- WebSocket output requires 48 kHz stereo s16 LE PCM and an application-owned gateway. The browser client is a separate package;
  it does not replace gateway authentication or routing.
- Keep public documentation and the package `AGENTS.md` guides aligned with changes to exported APIs and expected workflows.

## Validation

- `npm test` builds core and runs the root unit/regression tests.
- `npm test --prefix examples/backend` checks gateway handoff behavior.
- `npm test --prefix client` checks browser protocol validation and frame decoding.
- `npm run test:integration` runs plugin/extension integration tests when relevant.
- Use `npx prettier --check <changed paths>` and `git diff --check` for changed source and documentation.
- Do not edit generated `core/dist/` files directly.
