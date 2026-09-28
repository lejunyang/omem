/** Shared trail-stack types. A trail is a controlled, single floating drawer
 * that lets the user drill from a module -> file -> symbol -> decision -> test
 * and back. Frames are plain serializable records so the whole stack can be
 * round-tripped through location.hash for deep-link refresh. */

export type TrailFrameKind =
  | "module"
  | "file"
  | "symbol"
  | "fragment" // a review (doc/decision/research) fragment
  | "decision";

export type TrailFrame = {
  kind: TrailFrameKind;
  /** Stable identity for loop detection. */
  id: string;
  /** Short title shown in the drawer header / breadcrumb. */
  title: string;
  /** Where to scroll back to when this frame is popped. Managed by the drawer. */
  scroll?: number;
  /** Free-form refs the parent needs to load the frame's data. */
  fileId?: string;
  symbolId?: string;
  fragmentId?: string;
  line?: number;
  module?: string;
};

/** Serialize a frame to a hash path segment pair. */
export function frameToSegment(f: TrailFrame): string {
  return encodeURIComponent(f.kind) + "/" + encodeURIComponent(f.id);
}

/** Max trail depth we persist into the URL. */
export const MAX_TRAIL = 8;

/** Return the existing index of a frame with the same kind+id, or -1. Pure:
 * used by the container to decide whether pushing would loop. */
export function findLoop(frames: TrailFrame[], next: Pick<TrailFrame, "kind" | "id">): number {
  return frames.findIndex((f) => f.kind === next.kind && f.id === next.id);
}

/** Push a frame, bounded to MAX_TRAIL. Returns the new stack. */
export function pushFrame(frames: TrailFrame[], next: TrailFrame): TrailFrame[] {
  return [...frames, next].slice(-MAX_TRAIL);
}
