// Small shared controls: a button that asks once more in the page (no window.confirm), and copying text
// with a fallback where the clipboard API is missing or refused (plain http, older in-app browsers).
import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from "react";

type ConfirmProps = {
  label: string;
  ariaLabel?: string; // the label with its context, e.g. the person's name
  question: string; // e.g. "Spiel wirklich beenden?"
  confirmLabel?: string;
  onConfirm: () => void;
  disabled?: boolean;
  className?: string;
};

// Give it a key that names its target (a roll seq, a user id): when the target changes, the open
// question closes instead of confirming something else.
export function ConfirmButton({ label, ariaLabel, question, confirmLabel = "Ja", onConfirm, disabled = false, className = "" }: ConfirmProps) {
  const [asking, setAsking] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);

  // Focus follows the step: to "Abbrechen" when asking (the safe choice), back to the button after.
  useEffect(() => {
    if (asking) cancelRef.current?.focus();
    else if (wasAsking.current) openRef.current?.focus();
    wasAsking.current = asking;
  }, [asking]);

  if (!asking) {
    return (
      <button ref={openRef} type="button" className={className} aria-label={ariaLabel} disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="confirm" role="group" aria-label={question}>
      <span className="confirm-question">{question}</span>
      <button
        type="button"
        className="danger"
        disabled={disabled}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button ref={cancelRef} type="button" onClick={() => setAsking(false)}>
        Abbrechen
      </button>
    </span>
  );
}

// Copies text; if the browser refuses, shows it selected in a field so the user can copy it by hand.
export function CopyButton({ text, label, multiline = false }: { text: string; label: string; multiline?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  useEffect(() => {
    if (state === "manual") fieldRef.current?.select();
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [state]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("manual");
    }
  };

  let fallback: ReactNode = null;
  if (state === "manual") {
    const props = { ref: fieldRef, readOnly: true, value: text, "aria-label": label, onFocus: () => fieldRef.current?.select() };
    fallback = (
      <span className="copy-fallback">
        {multiline ? <textarea rows={Math.min(12, text.split("\n").length + 1)} {...props} /> : <input type="text" {...props} />}
        <span>Markiert: kopiere mit Strg+C oder lange tippen.</span>
      </span>
    );
  }
  return (
    <span className="copy">
      <button type="button" onClick={copy}>
        {label}
      </button>
      <span role="status" className="copy-status">
        {state === "copied" ? "Kopiert!" : ""}
      </span>
      {fallback}
    </span>
  );
}

// A button that is locked for a moment (a roll tumbling, the cooldown) instead of disabled: a disabled button
// drops keyboard focus to the page (checked in Chromium), and the host's next "Für … würfeln" is this button.
export function LockButton({ locked, onClick, ...rest }: Omit<ComponentProps<"button">, "disabled" | "type"> & { locked: boolean }) {
  return <button type="button" {...rest} aria-disabled={locked} onClick={(event) => !locked && onClick?.(event)} />;
}
