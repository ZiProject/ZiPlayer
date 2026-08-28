# Player Event Debugging

Enable verbose event tracing while diagnosing the Player decomposition.

The intended trace is:

```text
Controller / Orchestrator
  -> PlayerBus producer
  -> PlayerEventBridge: BUS EVENT
  -> PlayerEventBridge: PLAYER EMIT
  -> PlayerEventBridge: MANAGER EMIT
```

Every bridge event should include the guild/player id and, when available, request/session ids. Event producers should also log action/query lifecycle at the Bus boundary so a complete sequence can be reconstructed from logs.

## Expected diagnostic sequence

```text
[PlayerBus:<guild>] ACTION IN ...
[PlayerBus:<guild>] ACTION DISPATCH ...
[PlayerBus:<guild>] EVENT ... TRACK_LOADING
[PlayerEventBridge:<guild>] BUS EVENT ...
[PlayerEventBridge:<guild>] PLAYER EMIT ...
[PlayerEventBridge:<guild>] MANAGER EMIT ...
...
[PlayerBus:<guild>] EVENT ... TRACK_STARTED
...
```

## What to verify

- Every PlayerBus event has exactly one bridge trace.
- Every mapped public Player event has a corresponding PLAYER EMIT trace.
- Every mapped Manager event has a corresponding MANAGER EMIT trace.
- `requestId` and `sessionId` remain stable through async playback work.
- Stale sessions do not emit Player or Manager events after cancellation.
- Connection, playback, queue, preload and recovery events can be followed in one log stream.

Keep the tracing verbose while validating the refactor; it can later be guarded behind the project's debug/verbose logger setting once the event contract is stable.
