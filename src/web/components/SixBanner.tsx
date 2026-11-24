// Full-screen banner on a six (spec 10), for everyone. The text comes from the host's template (R6) and
// is rendered as text, never as HTML. Hosts get their "Weiter" button through children.
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react";
import { fillTemplate } from "../lib/ui.js";
import { DieFace } from "./Dice.js";
import "./SixBanner.css";

type Props = {
  template: string; // settings.sixMessage, with {name} and {platz}
  name: string;
  platz: number; // the gift number
  children?: ReactNode; // host only: e.g. <button onClick={continue}>Weiter</button>
};

const FOCUSABLE = "button:not([disabled]), a[href], input:not([disabled]), select, textarea, [tabindex='0']";

export function SixBanner({ template, name, platz, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Focus moves into the banner (the host's button, otherwise the text) and back where it was after.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = ref.current;
    (root?.querySelector<HTMLElement>(FOCUSABLE) ?? root?.querySelector<HTMLElement>("h2"))?.focus();
    return () => previous?.focus();
  }, []);

  // Keeps Tab inside the banner while it covers the page.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return event.preventDefault();
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div ref={ref} className="six-banner" role="alertdialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className="six-ribbon">
        <DieFace value={6} className="six-die" />
      </div>
      <h2 id={titleId} tabIndex={-1}>
        {fillTemplate(template, { name, platz })}
      </h2>
      {children && <div className="six-actions">{children}</div>}
    </div>
  );
}
