// Full-screen banner on a six (spec 10), for everyone. The text comes from the host's template (R6) and
// is rendered as text, never as HTML. Hosts get their "Weiter" button through children.
// A native modal <dialog>: the browser makes the whole page behind it inert, including elements mounted
// while it is open. The heading names the dialog, so screen readers announce the result on open.
import { type ReactNode, useId, useLayoutEffect, useRef } from "react";
import { fillTemplate } from "../lib/ui.js";
import { Confetti } from "./Confetti.js";
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
  const ref = useRef<HTMLDialogElement>(null);
  const unmounting = useRef(false);
  const titleId = useId();

  // Layout effect: open before the first paint, and close (which hands focus back) before React
  // removes the element.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    unmounting.current = false;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    (dialog.querySelector<HTMLElement>(FOCUSABLE) ?? dialog.querySelector<HTMLElement>("h2"))?.focus();
    return () => {
      unmounting.current = true;
      dialog.close();
      previous?.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="six-banner"
      role="alertdialog"
      aria-labelledby={titleId}
      // Only the host's "Weiter" ends the pause: Escape does nothing. Browsers let a repeated Escape
      // close it anyway (close watcher rules), so it reopens while the banner is still meant to show.
      onCancel={(event) => event.preventDefault()}
      onClose={() => !unmounting.current && ref.current?.showModal()}
    >
      <Confetti />
      <DieFace value={6} className="six-die" />
      <div className="ribbon-wrap">
        <h2 id={titleId} className="ribbon" tabIndex={-1}>
          {fillTemplate(template, { name, platz })}
        </h2>
      </div>
      {children && <div className="six-actions">{children}</div>}
    </dialog>
  );
}
