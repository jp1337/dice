// Paper confetti for the celebrations (a six, the result). CSS only: place, colour, shape and timing of each
// piece come from its nth-child rule in Confetti.css. Decorative; hidden with reduced motion.
import "./Confetti.css";

export function Confetti() {
  return (
    <div className="confetti" aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => (
        <i key={i} />
      ))}
    </div>
  );
}
