// Sound playback (spec 10.1). Browsers refuse audio before the first user gesture; instead of letting
// play() fail (and log), nothing is played until a gesture has happened. Kept free of React so the
// gating can be tested with fakes.

export type SoundName = "roll" | "six" | "turn";
export const SOUND_URLS: Record<SoundName, string> = { roll: "/sounds/roll.wav", six: "/sounds/six.wav", turn: "/sounds/turn.wav" };

export type Clip = { play(): Promise<void>; pause(): void; currentTime: number; muted: boolean };
type Target = Pick<EventTarget, "addEventListener" | "removeEventListener">;

// Events that grant user activation (HTML spec): keydown, a mouse button press (seen by pointerup at
// the latest), and the end of a touch.
const GESTURES = ["pointerup", "touchend", "keydown"];

export function createSoundPlayer(makeClip: (url: string) => Clip, target: Target, alreadyActive: boolean) {
  let clips: Record<SoundName, Clip> | null = null;
  const warming = new Set<Clip>();

  const unlock = () => {
    if (clips) return;
    for (const type of GESTURES) target.removeEventListener(type, unlock, true);
    clips = { roll: makeClip(SOUND_URLS.roll), six: makeClip(SOUND_URLS.six), turn: makeClip(SOUND_URLS.turn) };
    // iOS unlocks each media element separately, by playing it inside a gesture: once, muted.
    for (const clip of Object.values(clips)) {
      warming.add(clip);
      clip.muted = true;
      const done = () => {
        if (!warming.delete(clip)) return; // a real play() came first
        clip.pause();
        clip.currentTime = 0;
        clip.muted = false;
      };
      clip.play().then(done, done);
    }
  };

  if (alreadyActive) unlock();
  else for (const type of GESTURES) target.addEventListener(type, unlock, true);

  return {
    // Returns whether the sound was started.
    play(name: SoundName, muted: boolean): boolean {
      if (!clips || muted) return false;
      const clip = clips[name];
      warming.delete(clip);
      clip.muted = false;
      clip.currentTime = 0;
      clip.play().catch(() => {}); // e.g. the file failed to load: silence, not an error
      return true;
    },
  };
}
