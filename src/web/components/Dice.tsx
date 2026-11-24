// One or two dice (spec 10). A new rollKey starts the tumble; the roll present at mount (reconnect, late
// join) is shown without animation. Same duration for everyone: ROLL_ANIMATION_MS.
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useReducedMotion } from "../lib/hooks.js";
import { PIPS, ROLL_ANIMATION_MS, rollText } from "../lib/ui.js";
import "./Dice.css";

type Props = {
  values: readonly number[] | null; // null: nothing rolled yet, blank faces
  rollKey: string | number | null; // changes once per roll, e.g. the event seq
  count?: 1 | 2; // number of blank dice while values is null
  onSettled?: () => void; // the dice show the result: play the six sound, open the banner
};

const randomFace = () => 1 + Math.floor(Math.random() * 6);

export function DieFace({ value, className = "" }: { value: number | null; className?: string }) {
  return (
    <svg className={`die ${value === 6 ? "is-six" : ""} ${className}`} viewBox="0 0 100 100" aria-hidden="true">
      <rect className="die-body" x="3" y="3" width="94" height="94" rx="18" />
      {value !== null && PIPS[value]?.map(([cx, cy]) => <circle key={`${cx}-${cy}`} className="pip" cx={cx} cy={cy} r="8.5" />)}
    </svg>
  );
}

export function Dice({ values, rollKey, count = 1, onSettled }: Props) {
  const reduced = useReducedMotion();
  const [tumble, setTumble] = useState<number[] | null>(null);
  const [announcement, setAnnouncement] = useState(values ? rollText(values) : "");
  const lastKey = useRef(rollKey);
  const settled = useEffectEvent(() => onSettled?.());

  useEffect(() => {
    if (rollKey === lastKey.current || !values) return;
    lastKey.current = rollKey;
    setAnnouncement(""); // cleared first, so the same result twice is announced twice
    const spin = () => setTumble(values.map(randomFace));
    if (!reduced) spin();
    const tick = reduced ? undefined : setInterval(spin, 90);
    // Reduced motion: no tumble, the result right away (the short tick lets the live region change).
    const done = setTimeout(
      () => {
        clearInterval(tick);
        setTumble(null);
        setAnnouncement(rollText(values));
        settled();
      },
      reduced ? 50 : ROLL_ANIMATION_MS,
    );
    return () => {
      clearInterval(tick);
      clearTimeout(done);
      setTumble(null);
    };
    // Only a new roll restarts the animation; values belong to that roll.
  }, [rollKey]);

  const shown = tumble ?? values ?? Array<null>(count).fill(null);
  return (
    <div className="dice">
      {shown.map((value, i) => (
        <DieFace key={`${rollKey}-${i}`} value={value} className={tumble ? "is-rolling" : ""} />
      ))}
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
