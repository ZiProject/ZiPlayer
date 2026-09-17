**global bus + singleton controllers + state partition theo `playerId`**, đồng thời giữ lại các invariant/rủi ro đã phát hiện
trong hai tài liệu, mình đề xuất TODO chính thức như sau.

---

## 📋 Audit log

Đã clone branch, chạy `tsc --noEmit` + `tsup build` + `node --test tests/**/*.js` để kiểm tra thực trạng trước khi tick bất kỳ ô
nào. Kết quả:

**Thực trạng kiến trúc lúc bắt đầu (khác với những gì tên file/class gợi ý):**

- `PlayerManager.runtimes: Map<guildId, GlobalPlayerRuntime>` — **mỗi guild vẫn có một `GlobalPlayerRuntime` riêng**, không phải
  singleton toàn process dù tên gọi là "Global".
- Bên trong `GlobalPlayerRuntime` constructor: `this.bus = new PlayerBus()` — **mỗi player tự tạo bus riêng**, hàm
  `getGlobalPlayerBus()` đã tồn tại sẵn trong `PlayerBus.ts` nhưng không được gọi ở đâu cả (code mồ côi).
- `createControllerGraph()` gọi `new QueueController()`, `new PlaybackController()`, v.v. **cho từng player** — không phải
  singleton.
- **Branch không compile được**: `npx tsc --noEmit` ra 29 lỗi thật (sau khi cài đủ `node_modules`/`@types/node`), gần hết nằm ở
  `PlayerBus.ts` — `addListener`/`dispatch` không nhận `playerId`, thiếu hẳn method `normalizeSubscribeArgs` mà
  `onInput`/`onOutput` gọi tới, `onAction`/`action()` dùng `ScopedActionListener` như thể gọi được trực tiếp (sai kiểu),
  `requestRpcSync` không gắn `playerId` vào context dù type `PlayerBusRpcContext` đã bắt buộc field này, `query()`/`querySync()`
  gọi `handler()` với 0 argument dù `PlayerQueryHandler` yêu cầu 1 (`scope: PlayerQueryScope`). Ngoài ra 1 lỗi build riêng do
  export trùng tên `TrackResolverContext` (`types/core.ts` vs alias thừa trong `types/plugin.ts`).
- Đã audit tất cả 45 lời gọi `registerQuery(...)` trong `controller/*.ts`: **100% đăng ký handler dạng `() => this.someField`,
  không nhận `scope`** — do TypeScript cho phép hàm ít tham số hơn khớp kiểu hàm nhiều tham số hơn nên không bị báo lỗi, nhưng có
  nghĩa là **chưa controller nào thực sự đọc `playerId` để phân biệt player** — điều này bắt buộc phải xong ở "Global controller
  set" trước khi bật global bus, nếu không sẽ leak state giữa các guild.
- Vi phạm invariant phát hiện thêm: `SaveController` tự `new FilterController(...)` riêng (không qua composition root);
  `PlaybackSeekController`/`PlaybackStartController` gọi thẳng `PlaybackSessionController`;
  `PlayerEventBridge`/`PlayerConnectionBridge` vẫn import type `Player` trực tiếp. Chưa sửa trong lượt này.

**Đã làm (Phase 1 — chỉ trong `structures/PlayerBus.ts` + các call site literal thiếu `playerId` để build pass):**

1. `addListener`/`dispatch` giờ lưu và lọc theo `ScopedListener{playerId, handler}` bằng `playerIdsMatch()` (đã có sẵn helper
   trong `playerScope.ts`, chưa được dùng trước đó).
2. Thêm `normalizeSubscribeArgs()` — chuẩn hoá overload `(type, handler)` / `(type, playerId, handler)` dùng chung cho `onInput`,
   `onOutput`, `subscribe`, `onAction`.
3. `subscribe()` và `onAction()` giờ có overload nhận `playerId` (trước đó chỉ `onInput`/`onOutput` có, còn thiếu
   `normalizeSubscribeArgs` nên còn không compile được).
4. `action()` resolve một `playerId` thật cho execution context, lọc `actionListeners` theo scope, chạy handler trong
   `runWithPlayerId(playerId, ...)`.
5. `requestRpcSync()` giờ nhận `options?: PlayerBusRpcOptions` và gắn `playerId` vào context + request giống hệt `requestRpc()`
   (async) đã làm đúng từ trước.
6. `query()`/`querySync()` nhận thêm `playerId?` và luôn truyền `scope: PlayerQueryScope` cho handler (trước đó gọi `handler()`
   không tham số — sai kiểu).
7. Vá 4 call site còn thiếu `playerId` trong `PlayerMessageContext`/`PlayerActionExecutionContext` (`PlaybackPlayController`,
   `PlaybackStartController`, `PlaybackTrackEndController`, `PlayerAction.ts`) bằng cách truyền lại từ context cha hoặc
   `resolvePlayerId()`.
8. Xoá alias `TrackResolverContext` thừa trong `types/plugin.ts` (trùng tên với interface gốc trong `types/core.ts`, không ai dùng
   alias này).

**Kết quả verify:** `npx tsc --noEmit` → 0 lỗi. `npm run build` (tsup, CJS+ESM+DTS) → thành công. `node --test tests/**/*.js` →
53/55 pass; 2 fail (`lyricsExt.test.js` thiếu package phụ thuộc, `ttsplugin.test.js` gọi network Edge TTS bị 403 trong sandbox) —
cả hai **không liên quan** tới thay đổi, đã xác nhận bằng cách đọc lỗi.

**Cố ý CHƯA làm trong lượt này (rủi ro cao nếu làm mù, cần Phase riêng):**

- **Chưa** đổi `GlobalPlayerRuntime`/`PlayerManager` sang dùng `getGlobalPlayerBus()`. Nếu bật ngay bây giờ, tất cả guild sẽ dùng
  chung 1 bus nhưng mỗi guild vẫn có instance controller riêng của mình → mỗi controller sẽ nhận sự kiện/action của **mọi** guild
  khác (vì gọi `subscribe`/`onAction` không truyền `playerId` mặc định = wildcard) → vỡ cách ly giữa các guild ngay lập tức. Đây
  là lý do "Singleton hoá bus" không thể tách rời "Global controller set + state partition" một cách an toàn — phải làm gần như
  đồng thời hoặc theo đúng thứ tự: state partition trước, chuyển sang 1 controller instance sau, đổi bus cuối cùng.
- Chưa sửa 45 `registerQuery` handler để đọc `scope.playerId`, chưa sửa RPC handler tương ứng, chưa gộp controller thành
  singleton, chưa dọn 4 vi phạm nhỏ liệt kê ở trên (SaveController, controller gọi thẳng controller, import `Player`).

---

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

## Chốt architecture/invariant

### Protocol

- [x] Định nghĩa `PlayerId` canonical. (`structures/playerScope.ts`, đã có từ trước)
- [x] `PlayerMessageContext` bắt buộc có `playerId` trong type; toàn bộ call site tạo context trong `core/src` giờ compile đúng
      (đã vá 4 chỗ còn thiếu).
- [ ] Action payload/envelope bắt buộc có `playerId`. (`PlayerAction.playerId` vẫn optional ở type; `PlayerBus.action()` tự
      resolve giá trị thật cho execution context, nhưng envelope đầu vào chưa bắt buộc)
- [ ] Event payload/envelope bắt buộc có `playerId`. (tương tự, `PlayerEvent.playerId` vẫn optional)
- [ ] RPC request bắt buộc có `playerId`. (context RPC luôn có `playerId` thật nhờ `resolvePlayerId()`, nhưng option đầu vào vẫn
      optional)
- [x] Query request bắt buộc có `playerId` khi tới tay handler — `query()`/`querySync()` giờ luôn dựng
      `PlayerQueryScope{playerId}` trước khi gọi handler (trước đó gọi `handler()` không đối số, lỗi kiểu).
- [ ] Không cho phép request player-scoped thiếu `playerId`. (hiện vẫn fallback im lặng về `DEFAULT_PLAYER_ID` thay vì throw)
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

# Global `PlayerBus`

## 1. Singleton bus

- [ ] Tạo một `PlayerBus` duy nhất. (`getGlobalPlayerBus()` đã có sẵn trong `PlayerBus.ts` nhưng chưa được gọi ở đâu — xem note
      rủi ro ở audit log phía trên trước khi bật)
- [ ] Loại bỏ `new PlayerBus()` khỏi `Player`. (chưa audit riêng `Player.ts`, cần kiểm tra ở Phase kế)
- [ ] Loại bỏ `new PlayerBus()` khỏi từng `GlobalPlayerRuntime`. (**chưa làm** — vẫn `this.bus = new PlayerBus()` trong
      constructor)
- [ ] `PlayerManager`/runtime chỉ tham chiếu global bus. (**chưa làm** — `runtimes: Map<guildId, GlobalPlayerRuntime>`, mỗi
      runtime 1 bus riêng)
- [ ] Không có per-guild bus nữa. (**chưa làm**, xem trên)
- [x] Audit toàn bộ `new PlayerBus()` trong `core/src` — chỉ có đúng 1 chỗ: `GlobalPlayerRuntime` constructor.

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

- [x] `subscribe()` hỗ trợ `playerId` (overload `subscribe(type, playerId, handler)` mới thêm, dùng chung `normalizeSubscribeArgs`
      với `onInput`/`onOutput`/`onAction`).
- [x] `unsubscribe()` giữ đúng scope (closure trả về từ `addListener` chỉ xoá đúng `ScopedListener` entry của nó, không đụng tới
      listener khác).
- [ ] Event A không thể đến Player B. **Cơ chế lọc đã có** ở `dispatch()` (dùng `playerIdsMatch`), nhưng **chưa có call site nào
      trong `controller/*.ts` thực sự truyền `playerId` khi subscribe/publish** — tất cả vẫn mặc định wildcard nên hiện tại về
      hành vi chưa đổi gì. Cần Phase state-partition mới phát huy tác dụng.
- [x] Hỗ trợ wildcard/internal subscription (`PLAYER_ID_WILDCARD`, mặc định khi không truyền `playerId`).
- [ ] Test cross-player isolation. (chưa viết test — không có ý nghĩa để test tới khi có ít nhất 1 call site thật sự dùng scope
      khác wildcard)

Invariant:

```text
EVENT(player=A)
       ↓
A subscribers      ✓
B subscribers      ✗
C subscribers      ✗
```

---

# Global RPC / Query routing

## RPC

- [ ] RPC registry chỉ đăng ký handler **một lần**. (cấu trúc `Map<string, handler>` trong `rpcHandlers` vốn đã chỉ giữ 1
      handler/type kể cả trước đây — nhưng vì mỗi player có bus riêng nên "một lần" hiện tại nghĩa là "một lần mỗi player", chưa
      phải một lần toàn process)
- [ ] Không còn mỗi player register cùng RPC handler. (phụ thuộc việc chuyển sang global bus — chưa làm)
- [x] RPC handler nhận `playerId` thật trong context — `requestRpc()` đã đúng từ trước, `requestRpcSync()` vừa được vá để giống
      hệt (trước đó thiếu hẳn field `playerId`, không compile được).
- [ ] Handler lấy `state[playerId]`. (chưa — controller vẫn trả field đơn `this.xxx`, chưa đọc `context.playerId`)
- [ ] RPC không được access state của player khác. (chưa áp dụng được vì handler chưa phân biệt player)

Ví dụ:

```text
queue.add(player=A)
        ↓
QueueController
        ↓
queueStates.get(A)
```

## Query

- [x] `query()` có `playerId` (tham số optional mới, luôn resolve trước khi gọi handler).
- [x] `querySync()` có `playerId` (tương tự; trước đó gọi `handler()` 0 tham số — lỗi kiểu, không compile).
- [ ] Query handler phải explicit scope. Type `PlayerQueryHandler<K> = (scope: PlayerQueryScope) => ...` đã bắt buộc ở mức kiểu,
      và bus giờ luôn truyền `scope` thật — nhưng đã audit **cả 45/45 `registerQuery(...)` hiện có trong `controller/*.ts` đều
      khai báo handler dạng `() => this.xxx`, bỏ qua `scope`** (TS cho phép vì hàm ít tham số hơn khớp được kiểu hàm nhiều tham số
      hơn). Cần sửa từng controller ở Phase "Global controller set".
- [ ] Không còn global `"currentTrack"` ambiguity. (chưa — vẫn 1 giá trị chung do controller chưa partition theo `playerId`)

---

# Global controller set

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

# Player state registry

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

# Playback ownership

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

# Concurrency

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

# Resource / Stream

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

# Action ownership

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

# Error / Recovery

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

# Queue / Autoplay / Preload

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

# Connection

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

# Volume / Filter

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

# Plugin / Extension

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

# Remove circular dependencies

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

# Lifecycle

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

# Làm mỏng `Player.ts`

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

# Xóa `LegacyPlayer`

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

# Test

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

# Architecture scan

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
