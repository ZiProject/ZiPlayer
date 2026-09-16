**global bus + singleton controllers + state partition theo `playerId`**, đồng thời giữ lại các invariant/rủi ro đã phát hiện
trong hai tài liệu, mình đề xuất TODO chính thức như sau.

## 🎯 Mục tiêu cuối cùng

```text
                    PROCESS
                       │
              ┌────────▼────────┐
              │  Global Runtime │  ← duy nhất
              │                 │
              │  Global Bus     │  ← duy nhất
              │  Controllers    │  ← mỗi loại duy nhất
              └────────┬────────┘
                       │
             Map<PlayerId, State>
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
       Player A     Player B     Player C
       facade       facade       facade
```

**Nguyên tắc cốt lõi:**

1. **Một `PlayerBus` duy nhất cho toàn process.**
2. **Một instance của mỗi controller cho toàn process.**
3. Controller không thuộc guild/player nào.
4. Mọi state/resource có tính player-specific phải được partition bằng `playerId`.
5. Mọi action/query/RPC/event đều phải xác định `playerId`.
6. `Player` chỉ là facade.
7. `Player.destroy()` chỉ destroy state của player đó, **không destroy global infrastructure**.
8. `PlaybackOrchestrator` là owner duy nhất của active `PlaybackSession`.
9. Một authoritative execution path cho action.
10. Không còn `LegacyPlayer`.

---

# TODO — Global Bus + Singleton Controllers

## Phase 0 — Chốt architecture/invariant

### Protocol

- [ ] Định nghĩa `PlayerId` canonical.
- [ ] `PlayerMessageContext` bắt buộc có `playerId`.
- [ ] Action payload/envelope bắt buộc có `playerId`.
- [ ] Event payload/envelope bắt buộc có `playerId`.
- [ ] RPC request bắt buộc có `playerId`.
- [ ] Query request bắt buộc có `playerId`.
- [ ] Không cho phép request player-scoped thiếu `playerId`.
- [ ] Phân biệt rõ:
  - global message
  - player-scoped message
  - internal controller message.

### Invariant

- [ ] Controller không được giữ state mặc định cho “current player”.
- [ ] Không controller nào được suy ra `playerId` từ object `Player`.
- [ ] Không controller nào nhận toàn bộ `Player` làm dependency.
- [ ] Không controller nào trực tiếp gọi controller khác.
- [ ] Không có duplicate source-of-truth.

---

# Phase 1 — Global `PlayerBus`

## 1. Singleton bus

- [ ] Tạo một `PlayerBus` duy nhất.
- [ ] Loại bỏ `new PlayerBus()` khỏi `Player`.
- [ ] Loại bỏ `new PlayerBus()` khỏi từng `GlobalPlayerRuntime`.
- [ ] `PlayerManager`/runtime chỉ tham chiếu global bus.
- [ ] Không có per-guild bus nữa.
- [ ] Audit toàn bộ `new PlayerBus()` trong `core/src`.

**Definition:**

```text
new PlayerBus()
      ↓
     1 lần
      ↓
GlobalPlayerBus
```

---

## 2. Scoped subscription

Thay:

```ts
bus.subscribe("TRACK_START", handler);
```

bằng semantics kiểu:

```ts
bus.subscribe("TRACK_START", playerId, handler);
```

hoặc tương đương.

- [ ] `subscribe()` hỗ trợ `playerId`.
- [ ] `unsubscribe()` giữ đúng scope.
- [ ] Event A không thể đến Player B.
- [ ] Hỗ trợ wildcard/internal subscription nếu controller cần nghe toàn process.
- [ ] Test cross-player isolation.

Invariant:

```text
EVENT(player=A)
       ↓
A subscribers      ✓
B subscribers      ✗
C subscribers      ✗
```

---

# Phase 2 — Global RPC / Query routing

## RPC

- [ ] RPC registry chỉ đăng ký handler **một lần**.
- [ ] Không còn mỗi player register cùng RPC handler.
- [ ] RPC handler nhận `playerId`.
- [ ] Handler lấy `state[playerId]`.
- [ ] RPC không được access state của player khác.

Ví dụ:

```text
queue.add(player=A)
        ↓
QueueController
        ↓
queueStates.get(A)
```

## Query

- [ ] `query()` có `playerId`.
- [ ] `querySync()` có `playerId`.
- [ ] Query handler phải explicit scope.
- [ ] Không còn global `"currentTrack"` ambiguity.

---

# Phase 3 — Global controller set

Tạo một controller graph duy nhất:

```text
GlobalRuntime
├── QueueController
├── PlaybackController
├── StreamController
├── PreloadController
├── TransitionController
├── AntiStuckController
├── ConnectionController
├── VolumeController
├── FilterController
├── SearchController
├── Plugin/Extension bridge
└── LifecycleController
```

### Mỗi controller:

- [ ] Constructor chỉ chạy một lần.
- [ ] Không nhận `Player`.
- [ ] Không giữ `currentPlayer`.
- [ ] Không giữ `guildId`.
- [ ] State được index bằng `playerId`.
- [ ] Cleanup có thể clear `state[playerId]`.
- [ ] Có `destroyPlayer(playerId)` hoặc equivalent.
- [ ] Có `dispose()` cho **global shutdown**.

---

# Phase 4 — Player state registry

Thay:

```text
player → runtime → controllers
```

bằng:

```text
global controllers
       │
       ▼
PlayerStateRegistry
       │
       ├── A
       ├── B
       └── C
```

- [ ] Tạo `PlayerStateRegistry`.
- [ ] `playerId → PlayerContext`.
- [ ] `playerId → playback state`.
- [ ] `playerId → queue state`.
- [ ] `playerId → connection state`.
- [ ] `playerId → stream/resource state`.
- [ ] `playerId → preload state`.
- [ ] `playerId → filter state`.
- [ ] Xác định state nào thuộc controller nào.
- [ ] Không lưu cùng một state ở nhiều nơi.

---

# Phase 5 — Playback ownership

Đây vẫn là **P0**, không được bỏ qua chỉ vì chuyển sang singleton.

## `PlaybackSession`

- [ ] Chỉ `PlaybackOrchestrator` sở hữu active session.
- [ ] `PlaybackController.activeSession` bỏ nếu duplicate.
- [ ] `Player.currentTrack` không còn source-of-truth.
- [ ] `Player.currentResource` không còn source-of-truth.
- [ ] Queue không tự quyết định playback session.
- [ ] Preload không tạo session riêng.

Mục tiêu:

```text
PlaybackOrchestrator
        │
        ▼
PlaybackSession(playerId)
```

---

# Phase 6 — Concurrency

Phải bảo đảm:

```text
play(A)
 ↓
session A
 ↓
skip
 ↓
abort A
 ↓
play(B)
 ↓
session B
```

- [ ] Mọi async operation nhận session identity.
- [ ] Mọi async result validate session trước khi mutate.
- [ ] Resolver A trả về sau khi B active → discard.
- [ ] Stream A trả về sau B → discard.
- [ ] Resource A refresh sau B → discard.
- [ ] Preload A sau B → discard.
- [ ] Autoplay A sau B → discard.
- [ ] Queue related/willNext mutation phải session-aware.
- [ ] Không dùng generation counter làm concurrency primitive chính.
- [ ] Active session là authority.

---

# Phase 7 — Resource / Stream

- [ ] `StreamController` singleton.
- [ ] `StreamState[playerId]`.
- [ ] Resource ownership rõ ràng.
- [ ] Active resource thuộc đúng player/session.
- [ ] Resource replacement session-aware.
- [ ] Resource refresh thành transactional workflow.
- [ ] Stream cũ abort trước stream mới active.
- [ ] Không để stale stream attach vào `AudioPlayer`.
- [ ] `AudioPlayer` vẫn per-player.
- [ ] Không singleton hóa resource/player-specific audio objects.

---

# Phase 8 — Action ownership

Hiện có risk nhiều consumer cùng nghe action. Tài liệu đã xác định đây là vấn đề cần sửa.

Mục tiêu:

```text
Player
  ↓
PlayerAction
  ↓
ONE authoritative execution path
  ↓
Orchestrator / Controller
  ↓
events
```

- [ ] Audit toàn bộ `onAction`.
- [ ] Mỗi action xác định authoritative handler.
- [ ] `PLAY` không bị consume hai lần.
- [ ] `STOP` không bị consume hai lần.
- [ ] `SKIP` không bị consume hai lần.
- [ ] `PAUSE/RESUME` không duplicate.
- [ ] Xác định rõ Bus là routing/communication, không phải command queue.
- [ ] `PlayerAction` chịu execution ordering theo architecture đã chọn.

---

# Phase 9 — Error / Recovery

- [ ] Chỉ một owner quyết định outcome.
- [ ] `TrackLoader` báo lỗi.
- [ ] `PlaybackOrchestrator` quyết định:
  - retry
  - skip
  - fail.

- [ ] Không có nhiều error channel cạnh tranh.
- [ ] `TRACK_ERROR` semantics thống nhất.
- [ ] Recovery session-aware.
- [ ] Error từ stale session không mutate player hiện tại.

Mục tiêu:

```text
TrackLoader
    ↓
error
    ↓
Orchestrator
    ↓
RecoveryPolicy
 ┌──┼──┐
retry skip fail
```

Đây phù hợp với rủi ro error/recovery đã được xác định trước đó.

---

# Phase 10 — Queue / Autoplay / Preload

- [ ] `QueueController` singleton.
- [ ] Queue state theo `playerId`.
- [ ] `setRelated(playerId, ...)`.
- [ ] `setWillNext(playerId, ...)`.
- [ ] Autoplay state theo player.
- [ ] Preload state theo player.
- [ ] Preload session-aware.
- [ ] `TRACK_END(playerId)` route đúng player.
- [ ] Autoplay chỉ chạy nếu session vẫn active.
- [ ] Autoplay OFF → không tạo related/preload không cần thiết.
- [ ] Skip → autoplay tiếp tục đúng session mới.
- [ ] Không để stale autoplay mutate queue.

---

# Phase 11 — Connection

Tạo singleton:

```text
ConnectionController
```

- [ ] `ConnectionState[playerId]`.
- [ ] join.
- [ ] leave.
- [ ] reconnect.
- [ ] disconnect.
- [ ] voice state.
- [ ] AudioPlayer attach/detach.
- [ ] cleanup per player.
- [ ] Global dispose không xảy ra khi một guild destroy.

---

# Phase 12 — Volume / Filter

## Volume

- [ ] Singleton `VolumeController`.
- [ ] `VolumeState[playerId]`.
- [ ] set volume.
- [ ] mute/unmute.
- [ ] resource/filter interaction rõ ràng.

## Filter

- [ ] Singleton `FilterController`.
- [ ] `FilterState[playerId]`.
- [ ] filter source type.
- [ ] filter apply.
- [ ] filter resource replacement.
- [ ] Không để PlaybackController biết implementation filter.

---

# Phase 13 — Plugin / Extension

- [ ] Plugin registry là global.
- [ ] Player-specific plugin state nếu có → `playerId`.
- [ ] Extension registry global.
- [ ] Track resolver không nhận full `Player`.
- [ ] Dùng `TrackResolverContext`.
- [ ] Không còn dependency:

```text
TrackLoader → Player
```

- [ ] Không để Player làm service locator.
- [ ] `getStream()` compatibility surface chỉ tồn tại nếu thực sự cần.
- [ ] Code nội bộ mới không gọi legacy facade method.

---

# Phase 14 — Remove circular dependencies

Audit:

```text
Player
 ↓
Controller
 ↓
Player
```

- [ ] Controller không giữ `Player`.
- [ ] Resolver không nhận `Player`.
- [ ] Middleware không nhận full `Player` nếu không cần.
- [ ] Dùng capability/interface nhỏ.
- [ ] `TrackResolverContext`.
- [ ] `PlayerCapabilities`.
- [ ] Bus là communication boundary.

---

# Phase 15 — Lifecycle

Global lifecycle:

```text
process start
    ↓
GlobalRuntime
    ↓
GlobalBus
    ↓
Singleton Controllers
```

Player lifecycle:

```text
create(playerId)
    ↓
create state
```

Destroy:

```text
destroy(playerId)
    ↓
reject new actions
    ↓
abort PlaybackSession
    ↓
cancel preload
    ↓
stop playback
    ↓
close stream
    ↓
disconnect voice
    ↓
dispose player state
    ↓
remove playerId
```

**Không được:**

```text
destroy(player A)
       ↓
destroy GlobalBus
       ↓
destroy QueueController
```

- [ ] `destroy(playerId)` chỉ clear player.
- [ ] `dispose()` global chỉ chạy khi process/runtime shutdown.
- [ ] Cleanup ordering được test.
- [ ] Không còn event listener của player sau destroy.
- [ ] Không còn resource reference sau destroy.
- [ ] Không còn state entry trong registry.

---

# Phase 16 — Làm mỏng `Player.ts`

Chỉ làm sau khi các phase trên ổn định.

`Player` cuối cùng:

```text
Player
├── playerId
├── globalBus
├── manager/reference cần thiết
├── capabilities
└── public facade
```

Các method:

```text
play()
pause()
resume()
stop()
skip()
seek()
queue.*
connection.*
volume.*
events.*
queries.*
```

chỉ chuyển thành request:

```text
Player
   ↓
globalBus
   ↓
controller
```

- [ ] Sửa toàn bộ method gọi Bus để inject `playerId`.
- [ ] Không giữ runtime controller.
- [ ] Không giữ controller instance.
- [ ] Không giữ AudioPlayer implementation.
- [ ] Không giữ StreamManager.
- [ ] Không giữ Queue internals.
- [ ] Không giữ connection internals.
- [ ] Không giữ concurrency state.
- [ ] Không giữ recovery state.

---

# Phase 17 — Xóa `LegacyPlayer`

- [ ] `Player` không extends `LegacyPlayer`.
- [ ] Không import `LegacyPlayer`.
- [ ] Không import `Player.old.ts`.
- [ ] Không còn compatibility dependency nội bộ.
- [ ] Xóa `LegacyPlayer`.
- [ ] Xóa dead code.
- [ ] Xóa duplicate state.
- [ ] Xóa generation counters cũ.

Các state cần đặc biệt audit/xóa gồm `refreshGeneration`, `playbackOperationGeneration`, `recoveryGeneration`, `playNextPromise`,
`recoveryInProgress` và các state tương tự đã được liệt kê trong TODO trước.

---

# Phase 18 — Test

## Isolation

- [ ] Player A không nhận event B.
- [ ] Player B không nhận event A.
- [ ] RPC A không mutate B.
- [ ] Query A không đọc B.
- [ ] Controller singleton phục vụ đồng thời A/B/C.

## Concurrency

- [ ] play → skip → play.
- [ ] play A loading → play B.
- [ ] stale resolver.
- [ ] stale stream.
- [ ] stale resource refresh.
- [ ] stale preload.
- [ ] stale autoplay.
- [ ] simultaneous players.

## Lifecycle

- [ ] destroy A không ảnh hưởng B.
- [ ] destroy A trong lúc loading.
- [ ] destroy A trong lúc preload.
- [ ] destroy A trong lúc resource refresh.
- [ ] destroy A trong lúc recovery.
- [ ] global shutdown.

## Singleton assertions

Có thể test trực tiếp:

```ts
expect(playerA.bus).toBe(playerB.bus);
expect(queueControllerA).toBe(queueControllerB);
```

và quan trọng hơn:

```ts
expect(globalRuntime.bus).toBe(globalRuntime.bus);
```

chỉ có **một instance thực sự**.

---

# Phase 19 — Architecture scan

Cuối cùng chạy static scan để tìm:

```text
new PlayerBus()
new QueueController()
new PlaybackController()
new StreamController()
new PreloadController()
new ConnectionController()
```

Ngoài global composition root → **không được phép**.

Tìm:

```text
controller → Player
controller → controller
Player → runtime internals
playerId missing
```

Tìm mọi:

```text
subscribe(...)
query(...)
querySync(...)
rpc(...)
action(...)
event(...)
```

và xác nhận player-scoped operation đều có `playerId`.

---

# Definition of Done — Global Architecture

## 🟢 Infrastructure

- [ ] **1 `PlayerBus` / process**
- [ ] **1 instance mỗi controller / process**
- [ ] Global registry không chứa controller graph per player.
- [ ] RPC handler đăng ký một lần.
- [ ] Event subscription scoped theo `playerId`.

## 🟢 State

- [ ] State partition theo `playerId`.
- [ ] Không duplicate source-of-truth.
- [ ] Không controller nào sở hữu “current player”.
- [ ] PlaybackSession có một owner duy nhất.

## 🟢 Routing

- [ ] Action → đúng player.
- [ ] Event → đúng player.
- [ ] Query → đúng player.
- [ ] RPC → đúng player.
- [ ] Không cross-guild leakage.

## 🟢 Playback

- [ ] Một active session/player.
- [ ] Stale async result bị reject.
- [ ] Resource refresh atomic theo session.
- [ ] Preload session-aware.
- [ ] Autoplay session-aware.
- [ ] Recovery có một owner.

## 🟢 Lifecycle

- [ ] `destroy(A)` chỉ destroy A.
- [ ] B/C tiếp tục hoạt động.
- [ ] Global controllers sống xuyên suốt lifetime process.
- [ ] Global dispose chỉ khi process shutdown.

## 🟢 Player

- [ ] `Player` là facade.
- [ ] Không extends `LegacyPlayer`.
- [ ] Không chứa runtime internals.
- [ ] Không chứa concurrency bookkeeping.
- [ ] Không chứa resource lifecycle.
- [ ] Không chứa controller instances.
- [ ] Mọi request đều route bằng `playerId`.

## 🟢 Verification

- [ ] TypeScript build pass.
- [ ] Unit tests pass.
- [ ] Concurrency tests pass.
- [ ] Cross-player isolation tests pass.
- [ ] Lifecycle tests pass.
- [ ] Source scan không phát hiện per-player Bus/controller construction.

---
