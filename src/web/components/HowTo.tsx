// The rules in four lines (spec "Rules"), worded after the room's current settings.
import type { Settings } from "../../shared/contracts.js";

export function HowTo({ settings, open = false }: { settings: Settings; open?: boolean }) {
  return (
    <details className="card howto" open={open}>
      <summary>So wird gewürfelt</summary>
      <ul className="stack">
        <li>Reihum würfelt jede und jeder mit einem Würfel.</li>
        <li>
          <strong>Eine 6</strong> holt das nächste Geschenk: die erste 6 bekommt Geschenk Nr. 1, die zweite Nr. 2 und so weiter. Wer eine 6 hat, ist fertig.
        </li>
        <li>
          <strong>Eine 1</strong> ist ein Trostpreis: bei deinem nächsten Wurf hast du 2 Würfel, also doppelte Chance auf eine 6. Eine 6 reicht.
          {settings.bonusChains ? " Kommt mit 2 Würfeln wieder eine 1, gibt es nochmal 2 Würfel." : " Danach geht es wieder mit einem Würfel weiter."}
        </li>
        <li>
          {settings.lastPlayer === "choice"
            ? "Wer als Letzte oder Letzter übrig ist, würfelt weiter bis zur 6 oder nimmt den letzten Platz direkt."
            : "Wer als Letzte oder Letzter übrig ist, bekommt den letzten Platz sofort."}
        </li>
        <li>
          <strong>Fair gewürfelt:</strong> Die Augenzahl entsteht auf dem Server, nicht in deinem Browser. Jeder Würfel ist{" "}
          <code>crypto.randomInt(1, 7)</code> aus Node.js: ein kryptografisch sicherer Zufall, jede Zahl von 1 bis 6 gleich
          wahrscheinlich. Auch die Startreihenfolge lost der Server so aus. Niemand, auch kein Host, kann eine Augenzahl wählen. Nimmt ein Host einen Wurf zurück, etwa nach einem Versehen, steht er für alle sichtbar als „zurückgenommen“ im Verlauf.
        </li>
      </ul>
    </details>
  );
}
