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
  const unlocked = new Set<Clip>(); // played once inside a gesture: iOS lets it play from now on
  const warming = new Set<Clip>();

  const listen = (on: boolean) => {
    for (const type of GESTURES) (on ? target.addEventListener : target.removeEventListener).call(target, type, unlock, true);
  };
  const played = (clip: Clip) => {
    unlocked.add(clip);
    if (unlocked.size === Object.keys(SOUND_URLS).length) listen(false);
  };

  // Every gesture until each clip played once: the browser can refuse one (the end of a scroll swipe is no
  // tap, Escape is no activation), and with the listeners gone the sounds would stay silent for good.
  function unlock() {
    clips ??= { roll: makeClip(SOUND_URLS.roll), six: makeClip(SOUND_URLS.six), turn: makeClip(SOUND_URLS.turn) };
    // iOS unlocks each media element separately, by playing it inside a gesture: once, muted.
    for (const clip of Object.values(clips)) {
      if (unlocked.has(clip) || warming.has(clip)) continue;
      warming.add(clip);
      clip.muted = true;
      clip.play().then(
        () => {
          played(clip);
          if (!warming.delete(clip)) return; // a real play() came first
          clip.pause();
          clip.currentTime = 0;
          clip.muted = false;
        },
        () => {
          if (warming.delete(clip)) clip.muted = false; // refused: the next gesture tries again
        },
      );
    }
  }

  listen(true);
  if (alreadyActive) unlock();

  return {
    // Returns whether the sound was started.
    play(name: SoundName, muted: boolean): boolean {
      if (!clips || muted) return false;
      const clip = clips[name];
      warming.delete(clip);
      clip.muted = false;
      clip.currentTime = 0;
      clip.play().then(() => played(clip), () => {}); // e.g. the file failed to load: silence, not an error
      return true;
    },
  };
}
