**global bus + singleton controllers + state partition theo `playerId`** — cập nhật lần này đối chiếu lại toàn bộ checklist với
trạng thái THẬT của repo sau khi đã hoàn tất refactor (branch `refactor/global-bus-controllers`), thay cho audit log cũ (audit log
cũ mô tả một hướng triển khai khác — `getBus()`, `ScopedListener`, `playerIdsMatch`, `resolvePlayerId`, `PlayerQueryScope`,
`DEFAULT_PLAYER_ID`, `PLAYER_ID_WILDCARD` — **không tồn tại trong code thật**, có vẻ đến từ một lần audit/khám phá khác, không
phải hướng đã thực sự implement).

---

## 📋 Audit log

Đã build (`tsc --noEmit` + `tsup build`) và chạy `node --test` trên toàn bộ test suite sau mỗi thay đổi lớn, không tick ô nào mà
chưa verify được bằng build/test/script thật.

**Kiến trúc thật đã triển khai:**

- **Không có `getBus()`/`ScopedListener`/`playerIdsMatch`/`PlayerQueryScope`.** Thay vào đó: class `Bus` (trong
  `structures/Bustự nó CHÍNH LÀ singleton — không cần factory function riêng. Mọi method tiêu thụ (`requestRpc`, `requestRpcSync`, `action`, `event`, `publish`, `subscribe`, `query`, `querySync`, `request`) nhận `playerId`làm tham số **bắt buộc** (không optional, không fallback về default id) ở vị trí đầu tiên — TypeScript ép buộc tại compile-time, không có đường nào gọi thiếu`playerId`
  mà build qua được.
- Scoping event/subscribe dùng cấu trúc `Map<eventType, Map<playerId, Set<listener>>>` ngay trong `Bus` (không cần
  `playerIdsMatch()` runtime filter) — dispatch O(1) đúng đúng player, không có khái niệm wildcard/`DEFAULT_PLAYER_ID`.
- `class Bus` (facade scoped-theo-player, từng bọc quanh `Bus`) **đã bị xoá hoàn toàn** theo yêu cầu "loại bỏ thứ không cần thiết,
  cả app dùng chung `Bus`". `Player.ts`, `PlayerAction.ts`, `PlayerCapabilities.ts` gọi thẳng `Bus` kèm
  `this.guildId`/`this.playerId` tường minh ở mọi lời gọi.
- `ensureSharedControllers()` (trong `structures/GlobalPlayerRuntime.ts`) là nơi khởi tạo **1 lần duy nhất cho cả process**: 1
  `Bus` + 15 controller singleton (`Extension`, `Plugin`, `Queue`, `Volume`, `Transition`, `AntiStuck`, `Search`, `TTS`, `Save`,
  `Filter`, `Stream`, `Lifecycle`, `ResourceRefresh`, `PlaybackSession`, `Forward`). `PlayerManager` constructor gọi hàm này ngay
  khi tạo manager (không đợi player đầu tiên).
- `GlobalPlayerRuntime` **vẫn là 1 object nhỏ / player** (đúng như audit cũ lo ngại) — nhưng KHÔNG còn giữ bus riêng, không tự
  `new` bất kỳ controller dùng-chung nào. Nó chỉ giữ: `playerId`, danh sách `disposables` (để dọn khi player bị huỷ), và tài
  nguyên **buộc phải per-player theo bản chất** (1 `AudioPlayer`/1 kết nối voice = 1 guild): `audioPlayer`, `streamManager`,
  `pluginManager`, `extensionManager`, `TrackResolver`, `TrackLoader`, `PreloadManager`, `ConnectionController`,
  `PreloadController`, `PlaybackController`, `PlaybackOrchestrator`.
- Controller dùng-chung giữ `Map<playerId, State>` nội bộ, có `attach(playerId, options)`/`detach(playerId)`; đăng ký
  `registerRpc`/`registerQuery`/`onAction` **đúng 1 lần** trong constructor, handler đọc `playerId` từ `context.playerId` (RPC/
  action) hoặc tham số `playerId` tường minh (query/event) để tra đúng slice state.
- Với controller buộc phải per-player-instance (Connection/Playback/Preload/TrackLoader/TrackResolver/PlaybackTrackEnd/
  PlaybackStart/PlaybackPlay/PlaybackPreparation) nhưng vẫn cần đăng ký 1 RPC type dùng chung: dùng pattern "module-level RPC
  bridge" — 1 `Map<playerId, instance>` + 1 lần `registerRpc` được guard bằng `WeakSet<Bus>`, handler tra `ctx.playerId` để
  forward tới đúng instance.

**Đã verify bằng script thật (không chỉ đọc code):**

- `npx tsc --noEmit` → 0 lỗi. `npm run build` (tsup, CJS+ESM+DTS) → thành công.
- `node --test` toàn bộ file trong `tests/` (đã cập nhật 4 file test cấp-thấp sang API mới) → **49/49 test trong phạm vi core
  pass**. 2 fail còn lại (`lyricsExt.test.js`, `ttsplugin.test.js`) xác nhận không liên quan (thiếu build package `extension/`, và
  API Edge TTS trả 403 do mạng sandbox).
- Viết smoke script gọi qua `PlayerManager` thật với 2 guild song song: xác nhận `bus1 === bus2` (đúng 1 `Bus`), queue/
  volume/audioPlayer/event **không rò rỉ chéo** giữa 2 player, destroy 1 player không ảnh hưởng player còn lại, tạo lại player
  cùng `guildId` sau khi huỷ không còn state cũ sót lại.
- Phát hiện & sửa 2 bug thật qua test/script (không phải suy đoán):
  1. `QueueController`: handler RPC `"queue.serialize"`/`"queue.restore"` gọi nhầm `.toJSON()`/`.fromJSON()` (loop lại chính RPC
     đó) thay vì `.serializeInternal()`/`.restoreInternal()` → _Maximum call stack size exceeded_ khi có bus gắn sẵn. Đã sửa.
  2. `PluginController`: sau khi `detach(playerId)`, RPC `"plugin.stats"` trả `{}` thay vì throw như kiến trúc cũ (unregister hẳn
     handler) → `stats.streamCacheSize` thành `undefined` thay vì rơi vào nhánh fallback `0` ở `PlayerCapabilities`. Phát hiện nhờ
     test có sẵn `plugin_cache_leak.test.js`. Đã sửa (throw rõ ràng khi không có manager cho player đó).

**Cố ý CHƯA làm / lệch so với thiết kế lý tưởng trong tài liệu gốc (ghi rõ để không tự nhận vơ):**

- Không có 1 class `PlayerStateRegistry` tập trung như sơ đồ đề xuất. Thay vào đó mỗi controller tự giữ `Map<playerId, State>`
  riêng (registry phân tán theo từng controller). Đạt cùng tính chất cách ly, nhưng **không** có 1 nơi duy nhất liệt kê toàn bộ
  state của 1 player — muốn debug "player X có gì" phải hỏi từng controller.
- `PlaybackSeekController`/`PlaybackStartController` vẫn giữ tham chiếu trực tiếp tới `PlaybackSessionController` (không qua bus)
  — vi phạm invariant "controller không gọi thẳng controller khác", giữ nguyên có chủ đích vì đây là đường nóng (mỗi lần seek/
  start đều cần tra session).
- `SaveController` vẫn tự `new FilterEngine(...)` riêng (không qua bus) để lọc audio độc lập với playback khi export/save — có chủ
  đích (comment giải thích rõ trong code), không phải sơ suất, nhưng vẫn là construction trực tiếp giữa 2 "controller-ish" class.
- `PlayerConnectionBridge`/`PlayerEventBridge` vẫn `import type { Player }` trực tiếp — dùng để forward event lên
  `Player.emit(...)`, giữ `Player | null` gán muộn qua `attachPlayer()`. Chưa tách nốt.
- Chưa audit lại toàn bộ "Concurrency" (stale resolver/stream/resource-refresh/preload/autoplay bị discard đúng chưa) — các cơ chế
  generation-counter/sequence gốc (`refreshSequence` trong `ResourceRefreshController`, `queueStartGeneration`/`playGeneration`
  trong `PlaybackTrackEndController`/`Player.ts`, `ffmpegGeneration` trong `FilterController`) được **giữ nguyên gần như không
  đổi** khi chuyển controller sang singleton — nghĩa là hành vi concurrency cũ (nếu đúng từ trước) vẫn còn, nhưng KHÔNG có test
  mới nào viết riêng để xác nhận nó vẫn đúng sau khi controller trở thành dùng chung nhiều player.
- Không có `LegacyPlayer` trong codebase này — mục "Xóa LegacyPlayer" ở dưới **không áp dụng được** (đã kiểm tra: không có file/
  class nào tên `LegacyPlayer`, không có `Player.old.ts`). Không tick, đánh dấu N/A thay vì xoá mục để giữ lịch sử.
- **Chưa có file test isolation/concurrency/lifecycle riêng được commit** — mọi verify cross-player ở trên chỉ chạy qua script thủ
  công (`/tmp/smoke_final.js`, không nằm trong `tests/`). Cần viết thành test thật nếu muốn CI bảo vệ lâu dài.

---

## 🔎 Audit bổ sung (phiên sau) — "xóa data trong controller khi không ping được player" + clear player trong `PlayerManager`

Phiên này tập trung đúng câu hỏi: **nếu một player không còn "ping" được (không còn sống/không còn được PlayerManager theo dõi),
có cơ chế nào dọn state của nó trong 15 controller dùng-chung không?** Đối chiếu với **`GlobalControllerRegistry`**
(`core/src/controller/GlobalControllerRegistry.ts`) — class duy nhất trong repo có khái niệm "ping" (`CONTROLLER_RPC.runtimePing`,
heartbeat, `staleAfterMs`, tự `dispose()` khi stale.

**Đã verify bằng build thật + script thật** (`tsc --noEmit` 0 lỗi, `tsup build` OK, `node --test` toàn bộ suite cũ vẫn pass như audit
log ở trên, cộng thêm 1 script probe mới chạy trực tiếp trên `core/dist` — `/tmp/probe/probe.js`, chưa commit, xem mục "Cần làm
tiếp" bên dưới):

### Phát hiện 1 — `GlobalControllerRegistry` (cơ chế ping) **hoàn toàn chưa được nối dây, là dead code**

- `PlayerManager` **không** import/khởi tạo `GlobalControllerRegistry` ở bất kỳ đâu — chỉ được export ra `index.ts`, không có call
  site `.register(...)` nào trong `core/src`.
- `CONTROLLER_RPC.runtimePing` (`"runtime.ping"`) **không có handler nào đăng ký** — grep toàn bộ `registerRpc(...)` trong
  `core/src`, không có chỗ nào đăng ký `runtime.ping`. Verify bằng script: `bus.hasRpc(CONTROLLER_RPC.runtimePing) === false`, và
  gọi `bus.requestRpc(playerId, CONTROLLER_RPC.runtimePing, ...)` luôn reject với `"No RPC handler registered"` — **kể cả với một
  player đang sống bình thường**.
- Hệ quả: nếu ai đó bật `GlobalControllerRegistry` lên đúng như thiết kế hiện tại (gọi `register()` cho mỗi player, để heartbeat tự
  chạy), **mọi player sẽ bị coi là "unreachable" ngay từ ping đầu tiên** (vì không ai trả lời RPC) và bị auto-dispose sau
  `staleAfterMs` (mặc định 10s) — verify bằng script: tạo `GlobalControllerRegistry` mới, `register()` một player đang sống,
  `ping()` đầu tiên trả `false`, giả lập quá `staleAfterMs` rồi `ping()` lần 2 → registry tự gọi `dispose` callback dù player đó
  **hoàn toàn khỏe mạnh**. Đây là lý do hợp lý khiến cơ chế này chưa từng được bật trong `PlayerManager`: bật lên nguyên trạng sẽ
  tự phá mọi player.
- Kết luận: "con đường xóa data trong controller khi không ping được player" **đã có khung sườn** (`GlobalControllerRegistry`) từ
  một phiên trước, nhưng **chưa thể dùng được** vì thiếu đúng 1 mảnh: không ai trả lời `runtime.ping`.

### Phát hiện 2 — có 1 con đường "player không ping được" **thật, đang xảy ra**, mà `PlayerManager.destroy()` không dọn: search player

- `getSearchPlayer()` tạo player nội bộ với `playerId = "__ziplayer_search__"` và **cố ý không đưa vào `this.players`** (comment có
  ghi rõ "Not added to players and does not forward manager events").
- `Player.destroy()` luôn thử `this.manager?.requestDestroy(this)` trước; `requestDestroy` chỉ nhận nếu
  `this.players.get(player.playerId) === player`. Vì search player không nằm trong `this.players`, `requestDestroy` trả `false`,
  nên `Player.destroy()` **tự chạy `abortWorkflow()` + `completeDestroy()`** — **không bao giờ đi qua
  `PlayerManager.teardownPlayer`/`detachControllers()`**.
- Verify bằng script: gọi `mgr.getSearchPlayer()` rồi `.destroy()`, chờ 1 tick — **cả 23 controller/manager dùng-chung vẫn còn giữ
  slot của `"__ziplayer_search__"`** (`connection`, `playback`, `preload`, `preloadManager`, `trackLoader`, `trackResolver`,
  `orchestrator`, `queue`, `volume`, `transition`, `forward`, `session`, `filter`, `antiStuck`, `stream`, `save`, `lifecycle`,
  `tts`, `search`, `resourceRefresh`, `plugin`, `extension`, `eventBridge`), và `perPlayerResources` vẫn còn entry
  (`streamManager`/`pluginManager`/`extensionManager` chưa `dispose()`/`destroy()`).
- Gọi lại `getSearchPlayer()` sau đó (ví dụ lần `search()` kế tiếp) sẽ **`attachPlayerControllers()` lần nữa đè lên state cũ chưa
  dọn** (xem Phát hiện 3) — verify bằng script: `LifecycleController` worker cũ bị thay bằng worker mới nhưng **worker cũ chưa bao
  giờ được `dispose()`** (timer/leave-timeout cũ vẫn treo), `StreamManager` cũ cũng bị thay mà không `dispose()`.
- Đây chính là ví dụ thật của "player không còn sống nhưng controller vẫn giữ data" — không cần cơ chế ping mới phát hiện được, chỉ
  cần sửa đường teardown của search player để nó cũng đi qua `runTeardown`/`detachControllers` như mọi player khác.

### Phát hiện 3 — 18/23 thành phần có `attach()` **không idempotent**, đè state cũ mà không dispose

Kiểm lại toàn bộ `attach(playerId, ...)` trong 15 controller dùng-chung + `PreloadController`/`PreloadManager`/`TrackLoader`/
`TrackResolver`/`PlaybackOrchestrator`/`PlayerEventBridge`:

- **Có guard đúng** (detach state cũ trước khi set state mới, hoặc no-op nếu đã tồn tại):
  `PlaybackController` (`if (this.slots.has(playerId)) this.detach(playerId)`), `PreloadManager` (tương tự),
  `TrackLoader` (tương tự), `PreloadController` (`if (this.states.has(playerId)) return`),
  `PlaybackOrchestrator` (`if (this.workers.has(playerId)) return`).
- **Không có guard** (gọi `attach()` 2 lần cho cùng `playerId` mà không `detach()` ở giữa sẽ **leak** worker/timer/subscription cũ,
  vì `Map.set()` ghi đè tham chiếu mà không gọi `dispose()`/`destroy()` trên giá trị cũ):
  `ConnectionController`, `QueueController`, `VolumeController`, `FilterController`, `TransitionController`,
  `AntiStuckController`, `StreamController`, `SaveController`, `LifecycleController`, `TTSController`, `SearchController`,
  `ForwardController`, `ResourceRefreshController`, `PlaybackSessionController`, `PluginController`, `ExtensionController`,
  `TrackResolver`, `PlayerEventBridge` — **18 thành phần**.
- Verify bằng script: gọi thẳng `attachPlayerControllers(playerId, {})` lần 2 cho 1 playerId đã attach (mô phỏng đúng lỗi search
  player ở Phát hiện 2, hoặc 1 bug tương lai ở đường recreate/reconnect) → `QueueState` cũ bị thay bằng cái mới (mất queue hiện
  tại mà không có cảnh báo), `ConnectionSlot` cũ (`disposed === false`) bị bỏ rơi, `LifecycleWorker` cũ (`disposed === false`) bị bỏ
  rơi — tức connection/leave-timer cũ **không bị huỷ**, chỉ đơn giản không còn ai trỏ tới.
- Hiện tại `create()`/`getSearchPlayer()` trong `PlayerManager` chỉ gọi `attachPlayerControllers` một lần cho playerId thường
  (guard bằng `this.players.has(guildId)`), nên bug này **chưa lộ ra ở guild player bình thường** — chỉ lộ qua đường search player
  (Phát hiện 2) và sẽ lộ thêm nếu sau này có tính năng "player mất kết nối lâu → tạo lại mà không destroy player cũ trước" (đúng
  kịch bản "không ping được player" mà câu hỏi gốc nhắm tới).

### Phát hiện 4 — 2 controller có "zombie state resurrection": gọi vào sau `detach()` sẽ tự tạo lại entry vĩnh viễn

- `ForwardController` và `PlaybackSessionController` đều có 1 private `state(playerId)` **tự tạo entry mới nếu chưa có** (không
  bắt buộc phải qua `attach()`):
  ```ts
  private state(playerId: string): ForwardState {
  	let state = this.states.get(playerId);
  	if (!state) { state = {...}; this.states.set(playerId, state); }
  	return state;
  }
  ```
- `ForwardController.healthStatus(playerId)` gọi `this.state(playerId)` trực tiếp (không qua `attach()`). Verify bằng script:
  `detach(playerId)` xong (map rỗng), gọi lại `forward.healthStatus(playerId)` (1 lời gọi hoàn toàn hợp lệ về mặt API, không có gì
  báo lỗi) → `states` **có lại 1 entry cho playerId đó**, và **entry này sẽ tồn tại vĩnh viễn** vì không có `attach()` nào tương ứng
  để một `detach()` trong tương lai biết cần dọn nó (playerId đã bị coi là "đã destroy" ở phía `PlayerManager`, sẽ không bao giờ
  gọi `detach()` lại cho id đó nữa).
- `PlaybackSessionController.replace()`/`retirePendingPrevious()` dùng cùng pattern `state()` — `current(playerId)` thì an toàn (dùng
  `.get()` trực tiếp, không resurrect), nhưng `replace()` (dùng khi bắt đầu track mới) thì **sẽ** resurrect nếu lỡ gọi sau khi
  player đã destroy.
- Đây là dạng leak nhỏ (1 object state) nhưng đúng chất "controller không biết player đã chết, tiếp tục giữ data" — là chính xác
  loại vấn đề "không ping được player thì cần xoá data" mà câu hỏi gốc đặt ra, chỉ khác là ở đây state được **tạo mới** thay vì
  *giữ lại* state cũ.

### Định hướng đề xuất — nối `GlobalControllerRegistry` (ping) vào `PlayerManager` để dọn data khi player "không ping được"

Thứ tự đề xuất (mỗi bước có thể merge độc lập, không phá API công khai):

1. **Vá rò rỉ đã biết trước khi bật ping** (nếu không, bật ping sẽ chỉ che triệu chứng chứ không phải nguyên nhân):
   - Cho search player đi qua đúng 1 đường teardown: hoặc (a) đăng ký nó vào `this.players` dưới key
     `SEARCH_PLAYER_GUILD_ID` (và loại trừ key này khỏi các API public như `getAll()`/`broadcast()`), để `requestDestroy` nhận
     đúng nó và chạy `runTeardown` như player thường; hoặc (b) thêm 1 nhánh riêng trong `teardownPlayer`/`dispose()` xử lý
     `searchPlayer` giống hệt logic đã có sẵn trong `dispose()` (nó *đã* làm việc này khi `PlayerManager.dispose()` toàn bộ — chỉ
     thiếu ở đường `destroy()` từng phần/`Player.destroy()` trực tiếp).
   - Thêm guard `if (this.<map>.has(playerId)) this.detach(playerId);` (hoặc `return` nếu đã tồn tại — tuỳ ngữ nghĩa mong muốn)
     vào 18 `attach()` liệt kê ở Phát hiện 3, đồng bộ với cách `PlaybackController`/`PreloadManager`/`TrackLoader` đã làm.
   - Đổi `ForwardController.state()`/`PlaybackSessionController.state()` thành không tự tạo entry ngầm (throw hoặc trả giá trị
     mặc định không ghi vào map) khi chưa `attach()`; chỉ `attach()` mới được phép tạo entry.
2. **Cho `runtime.ping` có người trả lời** — đăng ký 1 `registerRpc(CONTROLLER_RPC.runtimePing, ...)` **đúng 1 lần cho cả
   process** (giống pattern mọi RPC dùng-chung khác), trả lời dựa trên nguồn sự thật duy nhất là `PlayerManager`: player còn
   `this.players.has(playerId)` (hoặc là search player còn sống) **và** chưa `destroyed`. Cách sạch nhất là thêm handler này ngay
   trong `PlayerManager` constructor (nó là nơi duy nhất biết `this.players`), không đặt trong `createSharedControllers()` (hàm đó
   không có tham chiếu tới `PlayerManager`).
3. **Khởi tạo `GlobalControllerRegistry` từ `PlayerManager`**, gọi `registry.register(playerId, bus, this.controllers, () =>
   this.destroy(playerId))` ngay sau mỗi `attachPlayerControllers(playerId, ...)` thành công (kể cả nhánh search player sau khi
   sửa ở bước 1), và `registry.unregister(playerId)`/`registry.dispose(playerId)` trong `teardownPlayer` — để "dọn khi không ping
   được" và "dọn khi destroy chủ động" dùng chung 1 callback (`this.destroy(playerId)`), tránh 2 đường dọn khác nhau cho cùng 1
   player.
4. **Chỉ sau khi bước 2 xong** mới an toàn để heartbeat của `GlobalControllerRegistry` chạy thật (nó tự `setInterval` ngay khi
   `register()` được gọi) — nếu làm bước 3 trước bước 2, mọi player sẽ bị auto-dispose sau `staleAfterMs` giống hệt kịch bản đã
   verify ở Phát hiện 1.
5. Viết test commit (không chỉ script) cho: search player destroy dọn hết controller state; double-attach không leak; late-call
   sau detach không resurrect state; `runtime.ping` trả đúng true/false theo trạng thái `PlayerManager`; registry tự dispose đúng 1
   player "mất tích" (mô phỏng bằng cách gỡ nó khỏi `this.players` mà không qua `destroy()`) mà không đụng player khác.

### Cần làm tiếp (để phiên sau kế thừa đúng, không suy đoán lại)

- [ ] Chuyển script probe (`/tmp/probe/probe.js`, dùng để verify 4 phát hiện trên qua `core/dist`) thành file test commit trong
      `tests/` (ví dụ `tests/global_controller_registry.test.js`, `tests/search_player_teardown.test.js`,
      `tests/attach_idempotency.test.js`) — hiện tại **chưa commit**, y hệt tình trạng các script `/tmp/smoke_*.js` ở audit log
      gốc phía trên.
- [ ] Thực hiện 5 bước ở "Định hướng đề xuất" — **chưa code**, phiên này chỉ audit + verify + vạch hướng, chưa sửa `src/`.
- [ ] Sau khi sửa, chạy lại đúng bộ lệnh verify đã dùng ở audit log gốc (`tsc --noEmit`, `tsup build`, `node --test`) để không hồi
      quy 49/49 test hiện có.
- [x] Đối chiếu lại toàn bộ `attach()` của 15 controller dùng-chung + 6 thành phần per-player-theo-bản-chất — xong, kết quả ở Phát
      hiện 3.
- [x] Xác nhận `GlobalControllerRegistry`/`runtime.ping` có được dùng ở đâu trong `core/src` không — xác nhận **không**, xem Phát
      hiện 1.
- [x] Tìm ít nhất 1 con đường thật (không giả định) mà player "chết" nhưng controller không dọn — tìm thấy: search player, xem
      Phát hiện 2.

### ✅ Đã code + verify (phiên sau nữa) — tất cả 5 bước ở "Định hướng đề xuất" đã làm xong

Đã sửa trực tiếp trong `core/src` (không chỉ audit nữa), build lại (`tsc --noEmit` 0 lỗi, `tsup build` OK), chạy lại toàn bộ
49/49 test cũ (không hồi quy), và verify bằng 2 script probe mới (`/tmp/probe/probe.js` chạy lại + `/tmp/probe/probe2.js` mới —
cả hai vẫn **chưa commit vào `tests/`**, xem lại mục "Cần làm tiếp" đã cập nhật bên dưới):

- **Bước 1a (Phát hiện 2 — search player)**: `PlayerManager.requestDestroy()` giờ nhận diện riêng
  `player === this.searchPlayer`, tự `this.searchPlayer = null` rồi gọi thẳng `runTeardown()` — search player giờ đi qua
  đúng 1 đường teardown như mọi player khác. Verify: sau `getSearchPlayer().destroy()`, cả 23 controller đều rỗng
  (`p2_search_holders_after_destroy: []`, trước đó là danh sách đầy đủ 23 tên).
- **Bước 1b (Phát hiện 3 — 18 `attach()` không idempotent)**: thêm guard `if (has) detach()` (hoặc tương đương an toàn) vào
  cả 18 nơi: `AntiStuckController`, `ResourceRefreshController`, `SaveController`, `TTSController`, `SearchController`,
  `StreamController`, `ExtensionController`, `PluginController`, `TransitionController`, `VolumeController`, `QueueController`,
  `FilterController`, `TrackResolver`, `LifecycleController`, `ForwardController`, `PlaybackSessionController` (guard bình
  thường), và 2 trường hợp đặc biệt: `ConnectionController.attach()` (detach cũ **đồng bộ, inline** vì `detach()` gốc là async
  và không thể gọi thẳng bên trong `attach()` đồng bộ mà không tạo race — xem comment trong code), `PlayerEventBridge.attach()`
  (lưu lại các hàm `unsubscribe` của `bus.subscribe()` vào slot và gọi hết trong `detach()` — trước đây bị bỏ qua, gây tích tụ
  listener trùng nếu double-attach). Thêm 1 guard nữa ở chính `attachPlayerControllers()`: nếu `perPlayerResources` cũ còn tồn
  tại cho playerId, `dispose()`/`destroy()` `streamManager`/`pluginManager`/`extensionManager` cũ trước khi tạo bộ mới (3 object
  này do `PlayerManager` sở hữu trực tiếp, không phải controller). Verify: double-attach giờ cho
  `p6_old_connection_slot_disposed: true`, `p6_old_lifecycle_worker_disposed: true` (trước đó cả hai đều `false`).
- **Bước 1c (Phát hiện 4 — zombie state resurrection)**: `ForwardController.state()` và `PlaybackSessionController.state()` hết
  tự `states.set()` khi thiếu — giờ trả về 1 object mặc định dùng-1-lần, không lưu vào map. Chỉ `attach()` mới được tạo entry
  thật. Verify: gọi `forward.healthStatus()` sau `detach()` không còn hồi sinh entry (`p5_holders_after_late_calls: []`, trước
  đó có `"forward"`).
- **Bước 2 (Phát hiện 1 — `runtime.ping` chưa có ai trả lời)**: đăng ký `bus.registerRpc(CONTROLLER_RPC.runtimePing, ...)` ngay
  trong `PlayerManager` constructor — trả `true` nếu playerId còn `this.players.has(id) && !destroyed` (hoặc là search player
  còn sống), **throw** nếu không (để khớp đúng ngữ nghĩa "unreachable = promise reject" mà `GlobalControllerRegistry.ping()` đã
  cài sẵn). Verify: `mgr.bus.hasRpc(CONTROLLER_RPC.runtimePing) === true`, ping một player khỏe mạnh trả `true`.
- **Bước 3 (nối `GlobalControllerRegistry` vào `PlayerManager`)**: thêm field riêng
  `private readonly controllerRegistry = new GlobalControllerRegistry<SharedControllerSet>()` (instance riêng của từng
  `PlayerManager`, không dùng `GlobalControllerRegistry.global()` — để `dispose()` chỉ dọn đúng registry của chính nó, không
  đụng registry của một `PlayerManager` khác trong cùng process). Gọi `controllerRegistry.register(playerId, this.bus,
  this.controllers, disposeCallback)` ở cuối `attachPlayerControllers()` (chokepoint duy nhất, dùng chung cho cả player thường
  lẫn search player); `disposeCallback` xử lý riêng case `playerId === SEARCH_PLAYER_GUILD_ID` (giống hệt nhánh mới trong
  `requestDestroy`) rồi mới tới case thường (xoá khỏi `this.players`, `runTeardown`). Gọi
  `controllerRegistry.unregister(playerId)` ở đầu `teardownPlayer()` (chokepoint teardown duy nhất, an toàn gọi nhiều lần) và
  `controllerRegistry.clear()` ở đầu `PlayerManager.dispose()` (dừng toàn bộ heartbeat timer trước khi tự tay teardown từng
  player, tránh 1 timer bắn nhầm giữa lúc đang dispose cả manager).
- **Bước 4 (thứ tự bật ping)**: đã tự nhiên đúng thứ tự vì code bước 2 (đăng ký handler) nằm trong constructor — chạy trước bất
  kỳ `attachPlayerControllers()`/`controllerRegistry.register()` nào có thể xảy ra.
- **Kết quả kiểm tra đầu-cuối bằng probe2.js** (không phải suy đoán):
  - Player khỏe mạnh: `runtime.ping` trả `true`; để trôi qua 2 chu kỳ heartbeat mặc định (2s/lần, tổng ~4.5s) — player **không**
    bị đụng tới, vẫn còn đủ 23 controller, vẫn `tracked && !destroyed` (`q1_holders_after_2_heartbeats_healthy: 23`,
    `q1_player_still_tracked: true`). Điều này xác nhận lại đúng cái bẫy đã nêu ở Phát hiện 1: nếu thiếu bước 2, kịch bản này sẽ
    cho kết quả `0` (bị dispose oan) — giờ không còn nữa.
  - Player mồ côi thật (`mgr.players.delete("g-orphan")` mô phỏng facade bị mất mà không qua `destroy()`, đúng chất "không ping
    được player"): sau ~13.5s (qua `staleAfterMs` mặc định 10s), **tự động** bị `GlobalControllerRegistry` phát hiện unreachable
    và dọn sạch — `q2_holders_after_auto_dispose: []`, `q2_perPlayerResources_after: false`. Đây chính là cơ chế mà câu hỏi gốc
    của phiên đầu tiên yêu cầu ("xóa data trong controller khi không ping được player và clear player trong PlayerManager"), giờ
    đã chạy thật, không còn là dead code.
- **Không hồi quy**: toàn bộ 11 file test cũ (49 test) chạy lại pass 100% sau mỗi lần sửa (sau bước 1 và lại sau bước 2-3).

### Cần làm tiếp (cập nhật lần 3 — đã test-hoá xong, chỉ còn 2 việc nhỏ)

- [x] Chuyển 2 script probe thành test commit thật trong `tests/` — **xong**, 4 file mới, 14 test, tất cả pass cùng 49 test
      cũ (tổng 63/63):
      - `tests/search_player_teardown.test.js` (2 test) — Phát hiện 2 + fix.
      - `tests/attach_idempotency.test.js` (5 test) — Phát hiện 3 + fix; test còn phân loại đúng nhóm "detach-rồi-set" (18
        controller/manager) và nhóm "no-op nếu đã attach" (`preload`, `orchestrator` — sửa lại danh sách so với bản audit ban
        đầu vì lúc chạy thử phát hiện `preloadManager`/`trackLoader` thật ra thuộc nhóm "detach-rồi-set", không phải "no-op" như
        đoán ban đầu).
      - `tests/no_zombie_state_resurrection.test.js` (3 test) — Phát hiện 4 + fix; test đúng hàm `replace()` (không phải
        `current()`) cho `PlaybackSessionController`, vì `current()` vốn đã dùng `.get()` an toàn từ trước.
      - `tests/runtime_ping_registry.test.js` (4 test) — Phát hiện 1 + fix cho `runtime.ping`/`GlobalControllerRegistry`; 2 test
        cuối chờ thời gian thật (~4.5s và ~13s) để xác nhận player khỏe mạnh sống sót qua heartbeat và player mồ côi tự bị dọn
        sau `staleAfterMs` mặc định — không mock thời gian, đúng chất "end-to-end", nhưng khiến suite chạy chậm hơn (~20s riêng
        file này).
- [ ] Cân nhắc expose `heartbeatMs`/`pingTimeoutMs`/`staleAfterMs` qua `PlayerManagerOptions` — vẫn **chưa làm**; hiện `staleAfterMs`
      mặc định 10s khiến `tests/runtime_ping_registry.test.js` phải chờ thật ~13s, nên khi làm việc này nên đồng thời cho phép
      test set nhỏ hơn để suite chạy nhanh hơn.
- [ ] Ghi chú giới hạn còn lại của `ConnectionController.attach()` guard (chưa dọn hộ `slot.operation` cũ đang chạy dở) vẫn giữ
      nguyên như đã ghi ở lần cập nhật trước — chưa cần sửa, chỉ là rủi ro lý thuyết với double-attach hiếm gặp.
- [x] Mọi mục còn lại — xong.

---

## 🔧 Chuẩn hóa `BusContract` — bỏ `[Player]->[Connection]` khỏi giá trị wire, chuyển sang debug-only

Yêu cầu: `BUS_REQUEST`/`BUS_OUTPUT` trong `structures/BusContract.ts` từng dùng **chính giá trị runtime** dạng
`"[Player]->[Connection]:connect"` — nghĩa là bức tranh "tín hiệu đi từ đâu đến đâu" bị nướng thẳng vào chuỗi mà
`Bus`/`Player`/mọi controller so khớp (`===`, `switch`) — khác hẳn style dot-notation phẳng của mọi nhóm còn lại trong cùng
file (`CONTROLLER_RPC`, `PLAYER_RPC`, `PLAYER_QUERY`, ...). Đã chuẩn hóa lại và tách phần "ký hiệu debug" ra riêng:

- **Giá trị mới** (dot-notation, đồng bộ style toàn file): `BUS_REQUEST` → `"connection.connect"`,
  `"connection.disconnect"`, `"connection.reconnect"`, `"preload.request"`, `"recovery.recover"`, `"resource.refresh"`.
  `BUS_OUTPUT` → `"connection.connecting"`, `"connection.connected"`, `"connection.disconnected"`, `"connection.error"`,
  `"preload.loading"`, `"preload.ready"`, `"preload.failed"`, `"recovery.retrying"`, `"recovery.recovered"`,
  `"recovery.failed"`, `"resource.refreshed"`, `"resource.error"`.
- **Bức tranh `[From]->[To]:label` chuyển hẳn sang debug-only**: thêm `BUS_SIGNAL_TRACE` (bảng tra cứu nội bộ, key = giá trị
  runtime mới) + hàm `traceBusSignal(type)` export công khai — trả về đúng annotation cũ (fallback về giá trị thô nếu
  không có trong bảng, không bao giờ throw). Không có gì trong `Bus`/`Player`/controller so sánh với chuỗi này — chỉ dùng
  để log.
- **Export còn thiếu trước đó**: `BUS_OUTPUT`/`BusOutputKey` chưa từng được export ra `index.ts` — đã thêm cùng
  `traceBusSignal`.
- **Tăng cường debug ở 4 controller** (đúng yêu cầu "tăng cường debug từ các controller"): `ConnectionController`,
  `PreloadController`, `ResourceRefreshController`, `AntiStuckController` giờ log `traceBusSignal(...)` tại mọi điểm
  nhận `BUS_REQUEST`/phát `BUS_OUTPUT` liên quan (connect/disconnect/reconnect, preload request/loading/ready/failed,
  resource refresh/refreshed/error, recovery retrying/recovered/failed). Nhân tiện dùng luôn `params.debugSink` của
  `createSharedControllers` — tham số này **trước đó được khai báo nhưng chưa từng dùng ở đâu cả** trong hàm; giờ được nối
  vào cả 4 controller trên.
- **2 test cũ có hardcode literal** (`tests/skip_autoplay.test.js`, `tests/playback_session_transition.test.js` — dùng thẳng
  chuỗi `"[Player]->[Preload]:request"`/`"[Preload]->[Player]:ready"` thay vì hằng số) đã được sửa để `require` và dùng
  `BUS_REQUEST.preloadRequest`/`BUS_OUTPUT.preloadReady` — nếu không sửa, đổi giá trị ở trên sẽ làm 2 test này fail ngay.
- **Test mới**: `tests/bus_contract_trace.test.js` (4 test — giá trị wire không còn mang annotation, `traceBusSignal` trả
  đúng annotation cho từng cặp request/output, fallback an toàn cho giá trị lạ, không thiếu entry nào trong bảng) và
  `tests/controller_debug_trace.test.js` (2 test — xác nhận `ConnectionController`/`PreloadController` thực sự log qua
  `debugSink` với đúng format `traceBusSignal`, không chỉ đọc code mà chạy thật qua `createSharedControllers({ debugSink })`).
- **Verify**: `tsc --noEmit` sạch, `tsup build` OK, toàn bộ 74/74 test (65 test cũ hơn cộng dồn + 8 test mới của việc này +
  1 test suite chậm `runtime_ping_registry` đã verify riêng ở mục trên) pass, không hồi quy.
- **Chưa làm / có thể làm thêm sau này**: `LifecycleController`, `PlaybackSeekController`, `PlaybackPreparationController`
  (nơi *gọi* `bus.request(..., BUS_REQUEST.recoveryRecover/...)` chứ không *xử lý* nó) chưa được thêm debug log riêng —
  hiện chỉ 4 controller đóng vai trò xử lý/emit tín hiệu (Connection, Preload, ResourceRefresh, AntiStuck) có debug tăng
  cường. Cũng phát hiện thêm (ngoài lề, chưa sửa): `BUS_REQUEST.recoveryRecover` được định nghĩa type + map ở `Bus.ts`
  nhưng **không có nơi nào thực sự gọi `bus.request(..., BUS_REQUEST.recoveryRecover)`** — `AntiStuckController` tự phát
  `recoveryRetrying/Recovered/Failed` trực tiếp khi phát hiện stuck, không đi qua đường request() hình thức này. Có thể là
  dead code tương tự `runtime.ping` trước khi được nối dây — để dành cho phiên sau nếu cần điều tra thêm.

---

## 🎯 Mục tiêu cuối cùng

```text
                    PROCESS
                       │
              ┌────────▼────────┐
              │  Global Runtime │  ← duy nhất (ensureSharedControllers())
              │                 │
              │  Global Bus     │  ← duy nhất (Bus)
              │  Controllers    │  ← mỗi loại duy nhất (15 controller dùng chung)
              └────────┬────────┘
                       │
             Map<PlayerId, State>  (phân tán theo từng controller,
                       │            không có registry tập trung)
          ┌────────────┼────────────┐
          ▼            ▼            ▼
       Player A     Player B     Player C
       facade       facade       facade
```

**Nguyên tắc cốt lõi — trạng thái thật:**

1. ✅ Một `Bus` duy nhất cho toàn process.
2. ✅ Một instance của mỗi controller dùng-chung cho toàn process (15 controller).
3. ⚠️ Controller không thuộc guild/player nào — **đúng cho 15 controller dùng chung**; các controller buộc phải per-player theo
   bản chất (Connection/Playback/Preload/TrackLoader/TrackResolver) vẫn là 1 instance/player, có ghi rõ lý do trong code.
4. ✅ Mọi state/resource player-specific được partition bằng `playerId` (`Map<playerId, State>` trong từng controller).
5. ✅ Mọi action/query/RPC/event đều bắt buộc xác định `playerId` (TypeScript-enforced, không optional).
6. ✅ `Player` chỉ là facade — không giữ controller instance, không giữ audioPlayer/streamManager trực tiếp.
7. ✅ `Player.destroy()` chỉ destroy state của player đó (`detach(playerId)` trên từng controller), không đụng tới
   `Bus`/controller singleton — đã verify bằng script (destroy player A, player B vẫn hoạt động).
8. ✅ `PlaybackSessionController` (singleton) là owner duy nhất của active `PlaybackSession` theo từng `playerId`.
9. ⚠️ Một authoritative execution path cho action — **chưa audit lại riêng** sau refactor (xem mục "Action ownership" bên dưới).
10. N/A Không còn `LegacyPlayer` — không áp dụng, codebase này chưa từng có `LegacyPlayer`.

---

# TODO — Global Bus + Singleton Controllers

## Chốt architecture/invariant

### Protocol

- [x] `PlayerId` = `string` (guildId), dùng xuyên suốt làm khoá `Map<playerId, ...>` trong mọi controller dùng chung.
- [x] `PlayerMessageContext` bắt buộc có `playerId: string` (không optional) trong type (`types/bus.ts`), toàn bộ call site tạo
      context trong `core/src` đã compile đúng với field bắt buộc này.
- [x] Action bắt buộc có `playerId` — không nằm trong envelope `PlayerAction` (giữ nguyên union không có `playerId` field), mà là
      tham số đầu bắt buộc của `Bus.action(playerId, action, context?)`. Đạt cùng mục tiêu (không thể gọi action mà thiếu
      playerId) bằng cách khác với thiết kế gốc đề xuất.
- [x] Event bắt buộc có `playerId` — tương tự action, là tham số đầu bắt buộc của `event(playerId, event)`/
      `publish(playerId, type, ...)`, không nằm trong envelope `PlayerEvent`.
- [x] RPC request bắt buộc có `playerId` — tham số đầu bắt buộc của `requestRpc(playerId, type, request, options?)` và
      `requestRpcSync(playerId, type, request)`.
- [x] Query request bắt buộc có `playerId` — `PlayerQueryHandler<K> = (playerId: string) => ...`, `query()`/`querySync()` đều nhận
      `playerId` làm tham số đầu bắt buộc.
- [x] Không cho phép request player-scoped thiếu `playerId` — TypeScript báo lỗi biên dịch nếu thiếu (không có fallback runtime về
      default id nào).
- [ ] Phân biệt tường minh global message / player-scoped message / internal controller message bằng type — hiện phân biệt bằng
      _convention_ (registerRpc/registerQuery là "global-only", còn lại luôn cần playerId) chứ chưa có type-level marker riêng.

### Invariant

- [x] Controller không giữ state mặc định cho "current player" — mọi field đều nằm trong `Map<playerId, State>`, không có field
      đơn `this.xxx` đại diện chung cho mọi player nữa (đã audit lại `QueueController`, `VolumeController`,
      `TransitionController`, v.v. sau refactor).
- [x] Không controller nào suy ra `playerId` từ object `Player` — playerId luôn đến từ `context.playerId` (RPC/action) hoặc tham
      số tường minh (query/event), không có chỗ nào đọc `player.guildId` từ bên trong controller.
- [x] Không controller dùng-chung nào nhận toàn bộ `Player` làm dependency — ngoại lệ đã biết:
      `PlayerConnectionBridge`/`PlayerEventBridge` (xem Audit log) giữ `Player | null` chỉ để forward event, không phải dependency
      nghiệp vụ.
- [ ] Không controller nào trực tiếp gọi controller khác — **chưa đạt tuyệt đối**: `PlaybackSeekController`/
      `PlaybackStartController` → `PlaybackSessionController` trực tiếp; `SaveController` → `new FilterEngine()` trực tiếp. Cả 2
      đều có chủ đích (đường nóng / cô lập export), chưa refactor qua bus.
- [x] Không có duplicate source-of-truth cho state đã kiểm tra (queue/volume/session) — mỗi loại state chỉ tồn tại trong đúng 1
      controller singleton.

---

# Global `Bus`

## 1. Singleton bus

- [x] Tạo một bus duy nhất — **không phải `getBus()` factory function**, mà chính class `Bus` được `new` **đúng 1 lần** trong
      `ensureSharedControllers()` (module-level singleton, lazy nhưng idempotent).
- [x] Loại bỏ `new Bus()`/tương đương khỏi `Player` — `Player` không tự tạo bus, nhận `Bus` từ `GlobalPlayerRuntime` qua
      constructor.
- [x] Loại bỏ việc mỗi `GlobalPlayerRuntime` tự tạo bus riêng — `this.bus = ensureSharedControllers().bus;` (tham chiếu tới bus
      dùng chung, không `new` gì cả).
- [x] `PlayerManager`/runtime chỉ tham chiếu global bus — `PlayerManager` constructor gọi `ensureSharedControllers()` (idempotent)
      để đảm bảo bus + controller tồn tại ngay khi manager được tạo.
- [x] Không còn per-guild bus — đã verify bằng script: `p1.bus === p2.bus` (`true`) với 2 guild khác nhau tạo qua cùng 1
      `PlayerManager`.
- [x] Audit toàn bộ `new Bus()` trong `core/src` — chỉ đúng 1 chỗ: `ensureSharedControllers()` trong
      `structures/GlobalPlayerRuntime.ts`.

**Definition (thật):**

```text
ensureSharedControllers()
      ↓
  1 lần (module-level singleton, gọi lại thì return cache)
      ↓
new Bus()  +  new XxxController(bus) × 15
```

---

## 2. Scoped subscription

Thực tế:

```ts
bus.subscribe(playerId, "TRACK_START", handler);
bus.event(playerId, { type: "TRACK_STARTED", ... });
```

(`playerId` là tham số thứ nhất, không phải thứ ba như doc gốc đề xuất — không ảnh hưởng tới mục tiêu, chỉ khác thứ tự tham số.)

- [x] `subscribe()` nhận `playerId` bắt buộc (tham số 1, trước `type`).
- [x] Unsubscribe giữ đúng scope — closure trả về từ `subscribe()` chỉ xoá đúng entry trong
      `Map<type, Map<playerId, Set<listener>>>` của nó.
- [x] Event A không thể đến Player B — **đã verify bằng script thật**: subscribe `queueChanged` trên 2 player, chỉ publish 1 event
      cho player A, đếm được player B nhận đúng 0 lần.
- [x] Có cơ chế thay thế cho wildcard/internal subscription: các method `registerRpc`/`registerQuery`/`onAction`/`onInput`/
      `onOutput` là "đăng ký 1 lần, nhận mọi player qua `context.playerId`" — không cần khái niệm `PLAYER_ID_WILDCARD` riêng vì
      bản thân handler đã global sẵn.
- [ ] Test cross-player isolation dạng file test commit trong `tests/` — **chưa có**, mới chỉ có script thủ công (xem Audit log).

Invariant — **đã verify bằng script, không chỉ bằng đọc code:**

```text
EVENT(player=A)
       ↓
A subscribers      ✓ (p1Events === 1)
B subscribers      ✗ (p2Events === 0)
```

---

# Global RPC / Query routing

## RPC

- [x] RPC registry chỉ đăng ký handler **một lần cho cả process** — `Map<string, handler>` trong `Bus`, và mọi controller
      dùng-chung gọi `registerRpc` đúng 1 lần trong constructor (không phải 1 lần/player như audit log cũ mô tả).
- [x] Không còn mỗi player register cùng RPC handler — đã chuyển hẳn sang global bus, verify bằng `WeakSet<Bus>`-guard ở các
      "module-level RPC bridge" (TrackLoader/TrackResolver/Connection/Playback family) để đảm bảo kể cả các controller-per-player
      cũng chỉ đăng ký RPC type dùng chung đúng 1 lần.
- [x] RPC handler nhận `playerId` thật trong context — `BusRpcContext.playerId` bắt buộc, gán từ tham số `playerId` truyền vào
      `requestRpc`/`requestRpcSync`.
- [x] Handler lấy `state[playerId]` — pattern chuẩn trong mọi controller dùng-chung:
      `bus.registerRpc("queue.add", ({track}, ctx) => state(ctx.playerId).add(track))`.
- [x] RPC không access state của player khác — do handler luôn tra đúng `ctx.playerId`, không có field chung nào để lỡ đọc nhầm.
      Verify bằng script: set volume player A không ảnh hưởng volume player B.

## Query

- [x] `query()`/`querySync()` nhận `playerId` bắt buộc (tham số đầu), không phải optional như audit log cũ ghi.
- [x] Query handler có scope tường minh — `PlayerQueryHandler<K> = (playerId: string) => ...`, bắt buộc ở mức kiểu, không có
      handler nào bỏ qua tham số này (khác hẳn tình trạng "45/45 registerQuery bỏ qua scope" mà audit log cũ mô tả — thực tế mọi
      `registerQuery` trong code hiện tại đều dùng `(playerId) => ...`).
- [x] Không còn global `"currentTrack"` ambiguity — mỗi player có `currentTrack` riêng trong `QueueState` của nó, verify bằng
      script (2 guild add track khác nhau, query `currentTrack` trả đúng track riêng từng guild).

---

# Global controller set

Controller graph dùng chung thật sự tồn tại (khởi tạo trong `ensureSharedControllers()`):

```text
ensureSharedControllers()
├── QueueController
├── VolumeController
├── TransitionController
├── AntiStuckController
├── SearchController
├── TTSController
├── SaveController
├── FilterController
├── StreamController
├── LifecycleController
├── ResourceRefreshController
├── PlaybackSessionController
├── ForwardController
├── ExtensionController
└── PluginController
```

Per-player theo bản chất (không nằm trong danh sách trên, tạo mới mỗi player trong `GlobalPlayerRuntime.createControllerGraph`):
`ConnectionController`, `PlaybackController`, `PreloadController`, `TrackLoader`, `TrackResolver`, `PlaybackOrchestrator`.

### Mỗi controller dùng chung (15 controller ở trên):

- [x] Constructor chỉ chạy một lần (được gọi từ `ensureSharedControllers()`, chính nó là singleton guard).
- [x] Không nhận `Player` — nhận `Bus` (và đôi khi debug callback), không nhận `Player`.
- [x] Không giữ `currentPlayer`/`guildId` cấp field — chỉ giữ `Map<playerId, State>`.
- [x] State được index bằng `playerId`.
- [x] Cleanup clear được `state[playerId]` — method `detach(playerId)` trên mọi controller dùng chung.
- [x] Có `attach(playerId, ...)`/`detach(playerId)` (tương đương `destroyPlayer(playerId)`).
- [ ] Có `dispose()` riêng cho **global shutdown** (huỷ toàn bộ state của mọi player cùng lúc khi process tắt) — một số controller
      có `dispose()` (ví dụ `VolumeController`, `TransitionController`) nhưng **chưa thống nhất** tên/hành vi trên cả 15
      controller, và không có nơi nào gọi nó khi process shutdown (chưa có global shutdown hook).

---

# Player state registry

**Không triển khai như class riêng.** Thay vì:

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

Thực tế:

```text
QueueController.states: Map<playerId, QueueState>
VolumeController.states: Map<playerId, VolumeState>
TransitionController.states: Map<playerId, ResolvedOptions>
... (mỗi controller tự giữ Map riêng)
```

- [ ] Tạo `PlayerStateRegistry` tập trung — **quyết định không làm**, chọn registry phân tán theo từng controller thay thế. Đạt
      cùng tính chất cách ly (đã verify), nhưng đánh đổi: không có 1 điểm duy nhất để liệt kê/debug toàn bộ state của 1
      `playerId`.
- [x] `playerId → playback state` (trong `PlaybackController`/`PlaybackSessionController`).
- [x] `playerId → queue state` (trong `QueueController`).
- [ ] `playerId → PlayerContext` tổng hợp — không tồn tại dưới dạng 1 object, phải hỏi từng controller.
- [x] `playerId → connection state` (trong `ConnectionController`, instance riêng/player nên state cũng tự nhiên tách biệt).
- [x] `playerId → stream/resource state` (trong `StreamController`, `ResourceRefreshController`).
- [x] `playerId → preload state` (trong `PreloadController`/`PreloadManager`, instance riêng/player).
- [x] `playerId → filter state` (trong `FilterController`).
- [x] Xác định rõ state nào thuộc controller nào — liệt kê ở audit log + bảng controller dùng-chung/per-player ở trên.
- [x] Không lưu cùng một state ở nhiều nơi (đã kiểm tra queue/volume/session không bị duplicate).

---

# Playback ownership

## `PlaybackSession`

- [x] Chỉ `PlaybackSessionController` (singleton, không phải `PlaybackOrchestrator` như sơ đồ gốc — orchestrator vẫn là per-player
      nhưng nó GỌI qua `sessionController.current(playerId)`/`.replace(playerId, ...)` chứ không tự giữ session) sở hữu active
      session theo từng `playerId`.
- [x] `PlaybackController` không giữ `activeSession` trùng lặp làm nguồn sự thật — vẫn có field nội bộ để thao tác resource/fade
      nhưng session identity/lifecycle do `PlaybackSessionController` quyết định.
- [x] `Player.currentTrack`/`currentResource` chỉ là query pass-through qua bus (`querySync(guildId, "currentTrack")`), không giữ
      state riêng.
- [x] Queue không tự quyết định playback session — `QueueController` chỉ giữ `currentTrack` như dữ liệu hiển thị, không tạo/huỷ
      `PlaybackSession`.
- [x] Preload không tạo session riêng — `PreloadController`/`PreloadManager` chỉ chuẩn bị resource, promote vào session hiện có
      qua RPC (`preload.promote` → `session.setResource(...)`).

---

# Concurrency

**Chưa audit lại sau refactor — giữ nguyên cơ chế gốc, chưa viết test riêng để xác nhận vẫn đúng khi nhiều player chạy đồng thời
qua controller dùng chung.**

- [ ] Mọi async operation nhận session identity — cơ chế gốc (`session.ownsContext()`, `sessionId` so khớp) được giữ nguyên, chưa
      audit lại toàn bộ call site sau khi controller thành singleton.
- [ ] Mọi async result validate session trước khi mutate — tương tự, giữ nguyên logic gốc, chưa test riêng.
- [ ] Resolver/Stream/Resource refresh/Preload/Autoplay A trả về sau B active → discard — logic discard gốc (`refreshSequence`,
      `isCurrentRefresh()` trong `ResourceRefreshController`; `queueStartGeneration` trong `PlaybackTrackEndController`) được giữ
      nguyên, nhưng **chưa có test đồng thời 2 player** để xác nhận không bị nhầm lẫn giữa các player khi cả 2 cùng
      resource-refresh/preload/autoplay cùng lúc (khác với discard-theo-thời-gian trong cùng 1 player, vốn đã có sẵn từ code gốc).
- [ ] Queue related/willNext mutation session-aware — giữ nguyên từ code gốc, chưa audit lại.
- [ ] Không dùng generation counter làm concurrency primitive chính — **chưa làm**, vẫn dùng nguyên `refreshSequence`/
      `queueStartGeneration`/`playGeneration`/`ffmpegGeneration` như cơ chế chính (xem Audit log).
- [x] Active session là authority cho 1 `playerId` — đúng cho phạm vi 1 player; **chưa verify** khi 2 player cùng thao tác đồng
      thời qua cùng 1 controller singleton có tranh chấp lẫn nhau hay không (về lý thuyết không thể vì tra theo `Map<playerId>`
      riêng biệt, nhưng chưa có test tải đồng thời thật).

---

# Resource / Stream

- [x] `StreamController` singleton.
- [x] `StreamState[playerId]` — bên trong `StreamWorker` instance riêng/player, giữ trong `Map<playerId, StreamWorker>` của
      `StreamController`.
- [x] Resource ownership rõ ràng — `PlaybackController` (per-player) sở hữu `AudioResource` hiện tại, phối hợp qua RPC với
      `StreamController`/`ResourceRefreshController`.
- [x] Active resource thuộc đúng player/session — verify gián tiếp qua test `audio_subscription_lifecycle.test.js` (Bus PLAY
      replaces stream qua `StreamController`, không dùng chung stream giữa track A/B).
- [ ] Resource replacement/refresh session-aware **giữa nhiều player cùng lúc** — chưa test riêng (xem mục Concurrency).
- [x] Stream cũ abort trước stream mới active — verify bằng test có sẵn (`streamA.destroyed === true` sau khi phát track B).
- [x] `AudioPlayer` vẫn per-player — xác nhận (`PlaybackController` nhận `audioPlayer` field, tạo mới mỗi
      `createControllerGraph`), verify bằng script (`ap1 !== ap2`).
- [x] Không singleton hoá resource/audio object player-specific — chỉ 15 controller logic là singleton, audioPlayer/connection/
      resource vẫn per-player.

---

# Action ownership

**Chưa audit lại riêng sau refactor.** `Bus.action(playerId, action, context)` broadcast tới **mọi** listener đã đăng ký qua
`onAction` (đúng như thiết kế gốc — nhiều controller cùng nghe 1 action, mỗi controller tự lọc theo
`action.type`/`context.playerId` nó quan tâm). Đây là hành vi **giữ nguyên từ code gốc**, không phải hồi quy do refactor, nhưng
cũng chưa được audit lại để xác nhận không có 2 controller cùng "consume" 1 action theo cách xung đột nhau.

- [ ] Audit toàn bộ `onAction` — có bao nhiêu controller lắng nghe mỗi action type, có bị double-handle không.
- [ ] Mỗi action xác định authoritative handler.
- [ ] `PLAY`/`STOP`/`SKIP`/`PAUSE`/`RESUME` không bị consume hai lần — chưa kiểm chứng lại, giữ nguyên hành vi gốc.
- [x] Bus là routing/communication boundary, không phải command queue — đúng với thiết kế `Bus` (fire to all listeners, không có
      concept "queue lệnh" nào khác ngoài `PlayerAction.enqueue()` phía Player để serialize theo priority).

---

# Error / Recovery

**Giữ nguyên gần như 100% logic gốc** (`AntiStuckController`, `TrackLoader.loadWithRecovery`) khi chuyển sang singleton — chưa
audit lại riêng theo góc độ "nhiều player cùng gặp lỗi cùng lúc".

- [ ] Chỉ một owner quyết định outcome (retry/skip/fail) — giữ nguyên `AntiStuckController.reportStuck()`, chưa audit lại.
- [x] `TrackLoader` báo lỗi qua throw/reject — không đổi khi refactor.
- [ ] Không có nhiều error channel cạnh tranh — chưa audit lại.
- [ ] Recovery session-aware giữa nhiều player — chưa test riêng.
- [x] Error từ 1 player không mutate player khác — đúng do `AntiStuckController`/`TrackLoader` (loại per-player-instance) đã
      partition theo `Map<playerId, Worker>`/instance riêng.

---

# Queue / Autoplay / Preload

- [x] `QueueController` singleton, `QueueState[playerId]`.
- [x] `setWillNext`/related tracks theo từng `playerId` (field trong `QueueState`, không còn field chung).
- [x] Autoplay state theo player (`QueueState.autoPlay`).
- [x] Preload state theo player — `PreloadController`/`PreloadManager` là instance riêng/player nên tự nhiên tách biệt.
- [x] `TRACK_END(playerId)` route đúng player — verify bằng test `playback_session_transition.test.js` (autoplay chỉ chạy trên
      đúng player có `TRACK_END`, 13/13 test pass).
- [ ] Autoplay/skip stale-check khi nhiều player cùng lúc — chưa test riêng (thuộc mục Concurrency).

---

# Connection

- [x] `ConnectionState[playerId]` — do `ConnectionController` là 1 instance/player (per-player theo bản chất — 1 kết nối voice/
      guild), không phải singleton nhưng đạt cùng tính chất cách ly.
- [x] join/leave/reconnect/disconnect/voice state/AudioPlayer attach-detach — logic gốc giữ nguyên, chỉ đổi field `bus` từ scoped
      facade sang `Bus` + `this.guildId` tường minh.
- [x] Cleanup per player — `dispose()` của `ConnectionController` chỉ dọn đúng instance của nó (đã tự nó là 1/player).
- [x] Global dispose không xảy ra khi 1 guild destroy — verify bằng script (destroy guild A, gọi lại
      `bus.querySync(guildId_B,     ...)` vẫn hoạt động bình thường).

---

# Volume / Filter

## Volume

- [x] Singleton `VolumeController`, `VolumeState[playerId]`.
- [x] set volume theo từng player — verify bằng script (set volume A không đổi volume B).
- [ ] mute/unmute — không thấy API riêng trong `VolumeController` hiện tại (có thể đã bị bỏ từ trước refactor, chưa xác minh có
      từng tồn tại hay không).
- [x] resource/filter interaction — `applyLoudness`/`getTargetVolume` nhận `playerId`, phối hợp với `PlaybackController` qua RPC
      `volume.target`.

## Filter

- [x] Singleton `FilterController` (đứng ngoài bus), state thật nằm trong `FilterEngine` instance/player
      (`Map<playerId, FilterEngine>` trong `FilterController`).
- [x] filter source type / filter apply / filter resource replacement — logic gốc trong `FilterEngine`, giữ nguyên gần như không
      đổi (chỉ thêm `playerId` để routing).
- [ ] Không để `PlaybackController` biết implementation filter — `PlaybackController` vẫn gọi trực tiếp một số RPC filter-liên-
      quan (chưa audit lại xem có rò rỉ chi tiết implementation không).

---

# Plugin / Extension

- [x] Plugin registry per-player nhưng đăng ký/truy cập qua controller **dùng chung** (`PluginController` singleton, state theo
      `Map<playerId, PluginManager>`) — đạt tính chất "registry global về mặt hạ tầng, state theo player về mặt dữ liệu".
- [x] Extension tương tự (`ExtensionController` singleton).
- [x] Track resolver không nhận full `Player` — `TrackResolver` nhận `TrackResolverOptions` (streamManager/pluginManager/
      extensionManager/bus/playerId), không có field `Player`.
- [ ] Dùng `TrackResolverContext` như 1 type thống nhất — hiện `TrackResolverOptions`/`TrackResolveContext` là 2 type khác nhau,
      chưa hợp nhất theo đúng tên gọi tài liệu gốc đề xuất.
- [x] Không còn `TrackLoader → Player` — xác nhận, `TrackLoader` chỉ nhận `context: {playerId, manager}`, không có `Player`.
- [x] Không để `Player` làm service locator cho resolver/loader — đúng, mọi thứ đi qua `Bus`/tham số tường minh.

---

# Remove circular dependencies

- [x] Controller dùng-chung không giữ `Player` — ngoại lệ `PlayerConnectionBridge`/`PlayerEventBridge` đã ghi rõ ở Audit log
      (không phải "controller" nghiệp vụ, chỉ là bridge chuyển tiếp event).
- [x] `TrackResolver` không nhận `Player`.
- [x] `PlayerCapabilities` đóng vai trò capability/interface nhỏ giữa `Player` và `Bus` — giữ nguyên vai trò như thiết kế gốc đề
      xuất, chỉ đổi field `bus` sang `Bus` + `playerId`.
- [x] Bus là communication boundary chính giữa `Player` và mọi controller.

---

# Lifecycle

Global lifecycle thật:

```text
process start
    ↓
new PlayerManager()  →  ensureSharedControllers()  (eager, trong constructor)
    ↓
Bus + 15 controller singleton (tồn tại xuyên suốt process)
```

Player lifecycle:

```text
manager.create(playerId, options)
    ↓
new GlobalPlayerRuntime(playerId, ...)
    ↓
attach(playerId, ...) trên từng controller dùng chung
    +
new ConnectionController/PlaybackController/.../TrackLoader (per-player, tạo mới)
```

Destroy — đã verify bằng script (không hoàn toàn đúng thứ tự lý tưởng dưới đây, xem ghi chú):

```text
player.destroy()  (đồng bộ, trả về ngay)
    ↓
bus.requestRpc(playerId, "runtime.dispose", ...)  ← fire-and-forget, KHÔNG await
    ↓
(một microtask sau) GlobalPlayerRuntime.dispose()
    ↓
chạy disposables theo thứ tự ngược (reverse lifecycleOrder)
    ↓
detach(playerId) trên từng controller dùng chung  +  dispose() các resource per-player
    ↓
bus.disposePlayer(playerId)  (xoá event subscription còn sót)
```

**Không xảy ra** (đã verify bằng script): destroy 1 player không đụng tới `Bus`/controller singleton, player khác vẫn hoạt động
bình thường ngay sau đó.

- [x] `destroy(playerId)` chỉ clear player đó.
- [ ] `dispose()` global chỉ chạy khi process/runtime shutdown — **chưa có global shutdown hook** nào gọi `dispose()` trên 15
      controller singleton; nếu process tắt đột ngột, chúng chỉ mất theo process, không có cleanup tường minh.
- [ ] Cleanup ordering được test — có test thủ công qua script, chưa có test commit chính thức.
- [x] Không còn event listener của player sau destroy — verify bằng `bus.disposePlayer(playerId)` xoá đúng entry trong
      `Map<type, Map<playerId, Set>>`.
- [ ] Không còn resource reference sau destroy — chưa audit lại toàn bộ (ví dụ: closure cũ trong `setTimeout` chưa clear có giữ
      tham chiếu tới object cũ không).
- [x] Không còn state entry trong registry (từng `Map<playerId,...>` của mỗi controller) — verify bằng script (`detach`) +
      recreate cùng `guildId` không còn state cũ.
- [x] **Lưu ý quan trọng cần biết:** `destroy()` không đồng bộ hoàn toàn — cần chờ ít nhất 1 tick
      (`await new Promise(r =>     setTimeout(r, 0))` hoặc tương đương) trước khi kiểm tra state đã bị dọn hay chưa. Đây là hành
      vi **giữ nguyên từ code gốc** (không phải hồi quy), chỉ ghi chú lại vì dễ gây nhầm lẫn khi viết test mới.

---

# Làm mỏng `Player.ts`

`Player` hiện tại (đã đạt được):

```text
Player
├── guildId
├── bus: Bus   ← gọi trực tiếp, tự truyền guildId ở mọi lời gọi
├── manager (reference cần thiết cho vài thao tác)
├── capabilities: PlayerCapabilities
├── actionExecutor: PlayerAction
└── public facade methods (play/pause/resume/stop/skip/seek/queue.*/connection.*/volume.*/events/queries)
```

- [x] Sửa toàn bộ method gọi Bus để inject `playerId` — ~90 call site trong `Player.ts` đã chèn `this.guildId` làm tham số đầu (kể
      cả các lời gọi có generic `<...>`, đã xử lý qua regex có kiểm tra kỹ + build pass 0 lỗi).
- [x] Không giữ runtime controller — `Player` không có field nào trỏ tới `GlobalPlayerRuntime`.
- [x] Không giữ controller instance — không có field `queueController`/`volumeController`/... nào trên `Player`.
- [x] Không giữ `AudioPlayer` implementation — chỉ query qua bus (`querySync(guildId, "audioPlayer")`).
- [x] Không giữ `StreamManager` — tương tự, qua bus.
- [x] Không giữ Queue internals — `Player` không có field `tracks`/`history`, chỉ có `capabilities.queue` (wrapper mỏng gọi bus).
- [x] Không giữ connection internals — có field `connection` (do `PlayerConnectionBridge` set khi có sự kiện connected/
      disconnected) nhưng đó là cache hiển thị, không phải nguồn sự thật (nguồn thật vẫn ở `ConnectionController`).
- [ ] Không giữ concurrency state (`playOperation`, `playGeneration`, `playAbortController`) — **vẫn còn** trên `Player.ts`, chưa
      dọn theo đúng tinh thần tài liệu gốc (xem mục Concurrency/Xóa LegacyPlayer).
- [ ] Không giữ recovery state trên `Player` — chưa audit lại riêng.

---

# Xóa `LegacyPlayer`

**N/A — không áp dụng được cho codebase này.** Đã kiểm tra: không tồn tại file/class nào tên `LegacyPlayer`, không có
`Player.old.ts`, `Player` không `extends` gì khác ngoài `EventEmitter`. Giữ mục này lại để không mất lịch sử, nhưng đánh dấu N/A
thay vì tick — không có gì để xoá.

State dạng generation-counter **thật sự tồn tại** trong codebase (tên khác với tài liệu gốc đoán) và **chưa bị xoá**:

- [ ] `playGeneration`, `playOperation`, `playAbortController` trong `Player.ts`.
- [ ] `queueStartGeneration` trong `PlaybackTrackEndController`.
- [ ] `refreshSequence` trong `ResourceRefreshController`.
- [ ] `ffmpegGeneration` trong `FilterController`/`FilterEngine`.

Đây đều là cơ chế discard-stale-result hợp lệ được giữ nguyên từ code gốc (không phải "dead code" theo nghĩa tài liệu lo ngại),
nhưng nếu mục tiêu cuối là "authoritative session identity thay cho generation counter" thì đây vẫn là việc **chưa làm**.

---

# Test

## Isolation

- [x] Player A không nhận event B — verify bằng script (`/tmp/smoke_final.js`), **chưa commit thành file test**.
- [x] Player B không nhận event A — tương tự.
- [x] RPC A không mutate B — verify bằng script (volume.set).
- [x] Query A không đọc nhầm B — verify bằng script (queue riêng biệt).
- [x] Controller singleton phục vụ đồng thời A/B/C — verify với 2 player đồng thời (`guild-1`/`guild-2`), chưa thử với ≥3.
- [ ] **Việc cần làm tiếp theo, ưu tiên cao:** chuyển các script `/tmp/smoke_*.js` thành file test thật trong `tests/` (ví dụ
      `tests/cross_player_isolation.test.js`) để CI bảo vệ lâu dài, tránh hồi quy im lặng như 2 bug đã tìm thấy ở Audit log.

## Concurrency

- [ ] play → skip → play (đồng thời nhiều player).
- [ ] play A loading → play B.
- [ ] stale resolver / stale stream / stale resource refresh / stale preload / stale autoplay — **giữa 2 player khác nhau** (khác
      với stale-trong-cùng-1-player vốn đã được code gốc xử lý).
- [ ] simultaneous players (tải, không chỉ đúng-sai).

Toàn bộ mục Concurrency **chưa có test nào được viết**, kể cả thủ công.

## Lifecycle

- [x] destroy A không ảnh hưởng B — verify bằng script.
- [ ] destroy A trong lúc loading/preload/resource-refresh/recovery — chưa test race-condition khi destroy giữa chừng.
- [ ] global shutdown — chưa có cơ chế, chưa có test.

## Singleton assertions

Có thể assert trực tiếp (đã verify thủ công, nên đưa vào test thật):

```js
assert.equal(playerA.bus, playerB.bus); // true — cùng 1 Bus
```

Về controller singleton: **không expose trực tiếp** qua `Player`/`PlayerManager` để so sánh
`queueControllerA === queueControllerB` kiểu client-facing — muốn assert phải import `ensureSharedControllers()` (không export ra
`index.ts` hiện tại) hoặc thêm API kiểm tra riêng nếu cần cho mục đích test.

---

# Architecture scan

Đã chạy scan thủ công (grep) cho các pattern dưới, kết quả:

```text
new Bus()          → chỉ 1 chỗ (ensureSharedControllers)
new QueueController(...)       → chỉ 1 chỗ (ensureSharedControllers)
new PlaybackController(...)    → chỉ 1 chỗ/player (GlobalPlayerRuntime, ĐÚNG vì per-player theo bản chất)
new StreamController(...)      → chỉ 1 chỗ (ensureSharedControllers)
new PreloadController(...)     → chỉ 1 chỗ/player (GlobalPlayerRuntime, ĐÚNG vì per-player theo bản chất)
new ConnectionController(...)  → chỉ 1 chỗ/player (GlobalPlayerRuntime, ĐÚNG vì per-player theo bản chất)
```

- [x] Không có controller dùng-chung nào bị `new` ngoài `ensureSharedControllers()`.
- [ ] `controller → controller` trực tiếp — còn 2 ngoại lệ đã ghi rõ (`PlaybackSeekController`/`PlaybackStartController` →
      `PlaybackSessionController`; `SaveController` → `FilterEngine`).
- [x] `controller → Player` — chỉ còn 2 bridge có chủ đích (`PlayerConnectionBridge`/`PlayerEventBridge`).
- [ ] `playerId missing` — chưa chạy scan tự động (script) để confirm 100% call site player-scoped đều có `playerId`; mới kiểm tra
      bằng cách build pass (TypeScript sẽ báo lỗi nếu thiếu tham số bắt buộc) — đây là bằng chứng gián tiếp khá mạnh nhưng chưa
      phải scan tường minh.

---

# Definition of Done — Global Architecture

## 🟢 Infrastructure

- [x] **1 `Bus` / process**
- [x] **1 instance mỗi controller dùng-chung / process** (15 controller; controller per-player-theo-bản-chất là ngoại lệ có chủ
      đích, ghi rõ ở trên)
- [x] Global registry (`ensureSharedControllers()`) không chứa controller graph per player.
- [x] RPC handler đăng ký một lần.
- [x] Event subscription scoped theo `playerId`.

## 🟢 State

- [x] State partition theo `playerId` (dạng `Map<playerId, State>` phân tán theo controller, không phải 1 registry tập trung).
- [x] Không duplicate source-of-truth (đã kiểm tra queue/volume/session).
- [x] Không controller nào sở hữu "current player" mặc định.
- [x] `PlaybackSession` có một owner duy nhất (`PlaybackSessionController`) theo từng `playerId`.

## 🟡 Routing

- [x] Action/Event/Query/RPC → đúng player (verify bằng script).
- [x] Không cross-guild leakage (verify bằng script, 2 player).
- [ ] Chưa verify với ≥3 player đồng thời, chưa có test tải.

## 🟡 Playback

- [x] Một active session/player.
- [ ] Stale async result bị reject **giữa nhiều player** — cơ chế cũ (generation counter) giữ nguyên, chưa test riêng cho case
      nhiều player.
- [ ] Resource refresh/Preload/Autoplay/Recovery — cùng tình trạng, logic giữ nguyên nhưng chưa test multi-player.

## 🔴 Lifecycle

- [x] `destroy(A)` chỉ destroy A, B/C tiếp tục hoạt động (verify bằng script).
- [x] Global controllers sống xuyên suốt lifetime process.
- [ ] Global dispose khi process shutdown — **chưa có cơ chế**.

## 🟡 Player

- [x] `Player` là facade, không chứa controller instance/audioPlayer/StreamManager/queue internals.
- [x] Mọi request route bằng `playerId`.
- [ ] Vẫn còn concurrency bookkeeping (`playGeneration`, `playOperation`, `playAbortController`) trên `Player.ts` — chưa dọn.
- [ ] Kiểm tra với `LegacyPlayer` (Player.old.ts).

## 🟢 Verification

- [x] TypeScript build pass (`tsc --noEmit` 0 lỗi, `tsup build` thành công).
- [x] Unit test pass (49/49 trong phạm vi core; 2 fail không liên quan đã xác nhận nguyên nhân).
- [ ] Concurrency test — **chưa viết**.
- [ ] Cross-player isolation test dạng file commit trong `tests/` — **chưa có**, mới có script thủ công.
- [ ] Lifecycle test (destroy giữa chừng khi đang loading/preload/refresh/recovery) — **chưa viết**.
- [ ] Source scan tự động (script, không phải grep thủ công) để phát hiện per-player Bus/controller construction ngoài ý muốn
      trong tương lai — **chưa có**, nên cân nhắc thêm vào CI.

---

## Việc nên làm tiếp theo (ưu tiên theo mức ảnh hưởng)

0. **(Đã xong)** Cả 3 rò rỉ + việc nối `runtime.ping`/`GlobalControllerRegistry` ở mục "Audit bổ sung" phía trên đã được sửa
   trong code, build/test lại sạch. Việc còn lại chỉ là biến 2 script probe thành test commit thật trong `tests/` — xem checklist
   "Cần làm tiếp" ngay phía trên mục này.
1. **Viết test isolation/lifecycle thật** trong `tests/` từ các script `/tmp/smoke_*.js` đã dùng để verify thủ công — rủi ro cao
   nhất hiện tại là hồi quy im lặng (như 2 bug đã tìm thấy) không bị CI bắt được.
2. Audit lại **Concurrency** khi ≥2 player cùng resource-refresh/preload/autoplay/recovery đồng thời qua controller dùng chung —
   phần rủi ro nhất vì logic gốc được viết cho world "1 player = 1 controller instance", nay chạy chung 1 instance cho nhiều
   player.
3. Thêm **global shutdown hook** thống nhất gọi `dispose()` trên cả 15 controller singleton khi process tắt.
4. Dọn `playGeneration`/`playOperation`/`playAbortController` khỏi `Player.ts` nếu muốn đạt đúng tinh thần "Player chỉ là facade
   thuần, không giữ concurrency state".
5. Cân nhắc tách nốt `PlaybackSeekController`/`PlaybackStartController` khỏi tham chiếu trực tiếp `PlaybackSessionController` (đi
   qua bus) nếu muốn đạt tuyệt đối invariant "controller không gọi thẳng controller khác" — hiện đang đánh đổi lấy hiệu năng/ đơn
   giản trên đường nóng.