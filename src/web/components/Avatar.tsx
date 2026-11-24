// Avatar (spec 5.1): the cached Discord image, or initials on a colour derived from the user id. Also
// the fallback when the image fails to load. Decorative: show the name next to it.
import { useState } from "react";
import { avatarTone, initials } from "../lib/ui.js";
import "./Avatar.css";

type Props = {
  userId: string;
  name: string;
  avatarUrl: string | null; // always null for guests
  size?: "sm" | "md" | "lg"; // 32, 48, 72 px
};

export function Avatar({ userId, name, avatarUrl, size = "md" }: Props) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (avatarUrl && avatarUrl !== failedUrl) {
    return <img className={`avatar avatar-${size}`} src={avatarUrl} alt="" onError={() => setFailedUrl(avatarUrl)} />;
  }
  return (
    <span className={`avatar avatar-${size} avatar-initials tone-${avatarTone(userId)}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
