/**
 * Manual migration note for Player.play().
 *
 * Goal: keep Player as a thin facade and route play() through PlayerBus RPC.
 * Do NOT copy this file into Player.ts wholesale.
 *
 * Current Player.play() contract:
 *   play(query: string | Track | SearchResult | null, requestedBy?: string): Promise<boolean>
 *
 * Target facade implementation:
 *
 * public play(
 *   query: string | Track | SearchResult | null,
 *   requestedBy?: string,
 * ): Promise<boolean> {
 *   return this.bus.requestRpc("play", { query, requestedBy });
 * }
 *
 * The existing play business logic must remain in PlaybackOrchestrator.
 * Preserve these semantics from the current implementation:
 * - destroyed player => false
 * - null query => continue current playback or play next
 * - string query => search first
 * - SearchResult => use result.tracks
 * - Track => single-track array
 * - search failure => debug + playerError + false
 * - empty tracks => false
 * - TTS interrupt path remains unchanged
 * - queue multiple tracks
 * - if already playing/paused, preload and return true
 * - otherwise start next track
 *
 * Suggested RPC request type for types/bus.ts:
 *
 *   play: {
 *     request: {
 *       query: string | Track | SearchResult | null;
 *       requestedBy?: string;
 *     };
 *     response: boolean;
 *   };
 *
 * Suggested registration location: PlaybackOrchestrator constructor,
 * next to its existing RPC/query registrations. The handler should call
 * the orchestrator's existing play business logic rather than reimplementing
 * it in PlayerRuntimeController.
 *
 * Important:
 * This file is intentionally only a handoff/instruction file so the
 * migration can be applied manually and reviewed before touching Player.ts.
 */
export {};
