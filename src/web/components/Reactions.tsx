// Emoji reactions (spec 4.11): the bar to send one, and the layer where everyone's fly over the dice.
import { useCallback, useEffect, useRef, useState } from "react";
import { reactionEmojis } from "../../shared/contracts.js";
import { FLOAT_MS, type FloatingEmoji, type ReactionEmoji, cooldownLeft, expandBurst, reactionLabels } from "../lib/ui.js";
import "./Reactions.css";

type BarProps = {
  onReact: (emoji: ReactionEmoji) => void; // send {type: "react", emoji}
  disabled?: boolean; // active player, or reactions switched off for the room
};

// aria-disabled instead of disabled: the button keeps keyboard focus through the 2 s cooldown.
export function ReactionBar({ onReact, disabled = false }: BarProps) {
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [cooling, setCooling] = useState(false);

  useEffect(() => {
    if (lastSentAt === null) return;
    const timer = setTimeout(() => setCooling(false), cooldownLeft(lastSentAt, Date.now()));
    return () => clearTimeout(timer);
  }, [lastSentAt]);

  const react = (emoji: ReactionEmoji) => {
    if (disabled || cooldownLeft(lastSentAt, Date.now()) > 0) return;
    setLastSentAt(Date.now());
    setCooling(true);
    onReact(emoji);
  };

  return (
    <div className="reaction-bar" role="group" aria-label="Reaktionen">
      {reactionEmojis.map((emoji) => (
        <button key={emoji} type="button" aria-label={reactionLabels[emoji]} title={reactionLabels[emoji]} aria-disabled={disabled || cooling} onClick={() => react(emoji)}>
          {emoji}
        </button>
      ))}
      <span key={lastSentAt ?? 0} className={`reaction-cooldown ${cooling ? "is-active" : ""}`} aria-hidden="true" />
    </div>
  );
}

// Feed it the server's {type: "reactions"} batches: add(message.emojis).
export function useFloatingReactions() {
  const [items, setItems] = useState<FloatingEmoji[]>([]);
  const nextId = useRef(0);
  const add = useCallback((emojis: readonly { emoji: ReactionEmoji; count: number }[]) => {
    const burst = expandBurst(emojis, nextId.current);
    nextId.current += burst.length;
    setItems((current) => [...current, ...burst]);
    const ids = new Set(burst.map((item) => item.id));
    // A timer, not animationend: that never fires where animations are switched off.
    setTimeout(() => setItems((current) => current.filter((item) => !ids.has(item.id))), FLOAT_MS + 500);
  }, []);
  return { items, add };
}

// Place inside the dice area, given class "reaction-stage" (position: relative). Decorative, so hidden from
// screen readers. hidden: the viewer switched reactions off (HIDE_REACTIONS_KEY).
export function FloatingReactions({ items, hidden = false }: { items: FloatingEmoji[]; hidden?: boolean }) {
  if (hidden) return null;
  return (
    <div className="floating-reactions" aria-hidden="true">
      {items.map((item) => (
        <span key={item.id} className={`floating-emoji lane-${item.lane} delay-${item.delay}`}>
          {item.emoji}
        </span>
      ))}
    </div>
  );
}
