// Participant list (spec 10, 4.9): avatar, name, Würfler/Zuschauer, Host/Co-Host, connected, test player.
// Hosts and co-hosts get the per-person tools in each row; the own role is switched in the "Du" card.
import type { ClientMessage, MemberView, RoomView } from "../../shared/contracts.js";
import { Avatar } from "../components/Avatar.js";
import { Switch } from "../components/Toggles.js";
import { type Derived, canBeCohost } from "../lib/room.js";
import { ConfirmButton } from "./Controls.js";

type Props = { view: RoomView; d: Derived; send: (message: ClientMessage) => void };

function Row({ m, d, send, lobby }: { m: MemberView; d: Derived; send: Props["send"]; lobby: boolean }) {
  const isMe = m.userId === d.myId;
  const player = m.participation === "player";
  const tools = d.showModeration && !isMe;
  return (
    <li className="person">
      <Avatar userId={m.userId} name={m.displayName} avatarUrl={m.avatarUrl} size="sm" />
      <span className="person-main">
        <span className="person-name" title={m.discordName ? `Discord: ${m.discordName}` : undefined}>
          {m.displayName}
          {isMe && " (du)"}
          {m.discordName && <span className="sr-only">, Discord: {m.discordName}</span>}
        </span>
        <span className="badges">
          <span className="badge">{player ? "Würfler" : "Zuschauer"}</span>
          {m.isHost && <span className="badge badge-host">Host</span>}
          {m.isCohost && <span className="badge badge-host">Co-Host</span>}
          {m.isSimulated && <span className="badge badge-test">Testspieler</span>}
          <span className={`badge conn-${m.connected ? "ok" : "lost"}`}>{m.connected ? "verbunden" : "getrennt"}</span>
        </span>
      </span>
      {tools && (
        <span className="person-tools">
          {lobby && (
            <Switch
              on={player}
              label="Würfelt mit"
              showState
              ariaLabel={`${m.displayName} würfelt mit`}
              disabled={!d.can.setParticipation}
              onChange={(on) => send({ type: "set_participation", userId: m.userId, participation: on ? "player" : "spectator" })}
            />
          )}
          {d.isHost && canBeCohost(m) && (
            <Switch
              on={m.isCohost}
              label="Co-Host"
              showState
              ariaLabel={`${m.displayName} ist Co-Host`}
              disabled={!d.can.setCohost}
              onChange={(on) => send({ type: "set_cohost", userId: m.userId, isCohost: on })}
            />
          )}
          {m.hasNickname && (
            <ConfirmButton
              label="Spitzname zurücksetzen"
              ariaLabel={`Spitzname von ${m.displayName} zurücksetzen`}
              question={`Spitznamen von ${m.displayName} zurücksetzen?`}
              disabled={!d.can.resetNickname}
              onConfirm={() => send({ type: "reset_nickname", userId: m.userId })}
            />
          )}
          {d.can.simulatedPlayers && m.isSimulated && (
            <button type="button" aria-label={`${m.displayName} entfernen`} onClick={() => send({ type: "remove_simulated_player", userId: m.userId })}>
              Entfernen
            </button>
          )}
        </span>
      )}
    </li>
  );
}

export function Participants({ view, d, send }: Props) {
  return (
    <ul className="people">
      {view.members.map((m) => (
        <Row key={m.userId} m={m} d={d} send={send} lobby={view.game.status === "lobby"} />
      ))}
    </ul>
  );
}
