# Player Event Flow

## Purpose

`PlayerBus` is the canonical internal event channel. Controllers publish lifecycle/state events to the bus and do not depend on
`Player` or `PlayerManager`.

The public event boundary is:

```text
controller
   │
   ▼
PlayerBus.event()
   │
   ▼
PlayerEventBridge
   ├── Player.emit(publicEvent, ...args)
   └── PlayerManager.emit(publicEvent, player, ...args)
```

This restores the manager-level event propagation that existed around `Player.old.ts` without coupling controllers to the manager.

## Event mapping

| PlayerBus event          | Player event             | Manager event            | Player payload           |
| ------------------------ | ------------------------ | ------------------------ | ------------------------ |
| `TRACK_LOADING`          | `trackLoading`           | `trackLoading`           | `session`                |
| `TRACK_LOADED`           | `trackLoaded`            | `trackLoaded`            | `session`                |
| `TRACK_STARTED`          | `trackStart`             | `trackStart`             | `session`                |
| `TRACK_ERROR`            | `playerError`            | `playerError`            | `error, session.track`   |
| `TRACK_END`              | `trackEnd`               | `trackEnd`               | `session`                |
| `STREAM_ABORTED`         | `streamAborted`          | `streamAborted`          | `session`                |
| `playbackStateChanged`   | `playbackStateChanged`   | `playbackStateChanged`   | `session`                |
| `playbackSessionCreated` | `playbackSessionCreated` | `playbackSessionCreated` | `session`                |
| `trackRequested`         | `trackRequested`         | `trackRequested`         | `track, session`         |
| `stateChanged`           | `stateChanged`           | `stateChanged`           | `oldState, newState`     |
| `STUCK_DETECTED`         | `trackStuck`             | `trackStuck`             | `session.track, reason`  |
| `RECOVERY_STARTED`       | `recoveryStart`          | `recoveryStart`          | `session`                |
| `RECOVERY_FAILED`        | `recoveryFailed`         | `recoveryFailed`         | `session, session.track` |
| `preloadStateChanged`    | `preloadStateChanged`    | `preloadStateChanged`    | `state`                  |
| `preloadPromoted`        | `preloadPromoted`        | `preloadPromoted`        | `track`                  |
| `preloadCancelled`       | `preloadCancelled`       | `preloadCancelled`       | none                     |
| `queueChanged`           | `queueChange`            | `queueChange`            | `queue`                  |
| `volumeRequested`        | `volumeChange`           | `volumeChange`           | `volume`                 |

## Manager payload contract

Manager events always receive the originating `Player` as the first argument:

```ts
manager.on("trackStart", (player, session) => {
	// player.guildId identifies the source player
});
```

This is intentionally different from the Player-level event payload. The Player-level event keeps the event payload local to that
player; the Manager-level event adds the source player so one listener can handle multiple guilds.

## Legacy parity notes

`Player.old.ts` emits public events such as `trackStart`, `trackEnd`, `playerPause`, `playerResume`, `playerStop`, `queueEnd`,
`playerError`, `trackStuck`, `streamError`, `willPlay`, `forwardModeStart`, and `forwardModeEnd`.

The current decomposition already has canonical Bus events for playback, recovery, preload, queue, and state. The bridge only
forwards events that have a corresponding canonical Bus event today. Events without a Bus producer must be added at their source
before they can be bridged safely.

In particular, `playerPause`, `playerResume`, `playerStop`, `queueEnd`, `willPlay`, `streamError`, and forward-mode lifecycle
events still need canonical Bus producers for full `Player.old.ts` parity.

## Rules

1. Controllers publish to `PlayerBus`; they must not call `manager.emit()` directly.
2. `PlayerEventBridge` is the only adapter from internal Bus events to public Player/Manager events.
3. Manager listeners receive the source `Player` as argument zero.
4. Destroying a Player disposes the bridge before clearing the bus.
5. New public events should first be added to `PlayerBus`, then documented here, then mapped by `PlayerEventBridge`.
