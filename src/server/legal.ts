// Server-rendered legal pages (spec 9.1, 9.2). All content comes from the LEGAL_* configuration.
import type { Legal } from "./config.js";

export const REPO_URL = "https://github.com/jp1337/dice";

export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const notConfigured = "<p><strong>Angaben nicht konfiguriert.</strong></p>";

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex">
<meta name="color-scheme" content="light dark">
<title>${title} – Würfel</title>
</head>
<body>
<main>
<h1>${title}</h1>
${body}
</main>
<footer>
<nav><a href="/">Start</a> · <a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a> · <a href="${REPO_URL}">GitHub</a></nav>
</footer>
</body>
</html>
`;
}

function contact(legal: Legal) {
  const email = escapeHtml(legal.email);
  return `<p>${[legal.name, ...legal.addressLines].map(escapeHtml).join("<br>\n")}</p>
<p>E-Mail: <a href="mailto:${email}">${email}</a></p>`;
}

export function impressumHtml(legal: Legal | null) {
  if (!legal) return page("Impressum", notConfigured);
  const note = legal.note ? `\n<p>${escapeHtml(legal.note)}</p>` : "";
  return page("Impressum", `<p>Angaben gemäß § 5 DDG</p>\n${contact(legal)}${note}`);
}

export const PRIVACY_UPDATED = "24. November 2026";

export type PrivacyServices = { cloudflare: boolean; crowdsec: boolean; retentionDays?: number };

// Vendor facts checked against (2026-11-24):
// CrowdSec: https://docs.crowdsec.net/docs/next/central_api/intro (signal meta-data: scenario, timestamp, machine ID, offending IP)
// Cloudflare: https://www.cloudflare.com/trust-hub/gdpr/ (processor for end-user log data, mainly IP addresses, US and EU data centres)
// Cloudflare cookies (all "strictly necessary" per Cloudflare): https://developers.cloudflare.com/fundamentals/reference/policies-compliances/cloudflare-cookies/
function protection(services: PrivacyServices) {
  const crowdsec = services.crowdsec
    ? `
<p>Auf dem Server läuft CrowdSec, ein lokaler Schutz gegen Angriffe. CrowdSec wertet die Zugriffsprotokolle aus und sperrt auffällige IP-Adressen. Erkennt es einen Angriff, meldet es die IP-Adresse, die Art des Angriffs und den Zeitpunkt an das CrowdSec-Netzwerk (CrowdSec SAS, Frankreich). Die Protokolle selbst werden nicht übertragen.</p>`
    : "";
  const cloudflare = services.cloudflare
    ? `
<p>Vor dem Server liegt Cloudflare (Cloudflare, Inc., USA) als Reverse Proxy und Content Delivery Network. Alle Anfragen und Antworten laufen über das Netz von Cloudflare. Cloudflare verarbeitet dabei die IP-Adresse und die Daten der Anfrage, auch in Rechenzentren in den USA. Zur Abwehr von Bots kann Cloudflare eigene, technisch notwendige Cookies setzen, etwa <code>__cf_bm</code> oder <code>cf_clearance</code>.</p>`
    : "";
  return `<h2>Hosting und Schutzdienste</h2>
<p>Die App läuft auf einem Server von Hetzner (Hetzner Online GmbH) in Deutschland.</p>${crowdsec}${cloudflare}`;
}

export function datenschutzHtml(legal: Legal | null, services: PrivacyServices = { cloudflare: false, crowdsec: true }) {
  const days = services.retentionDays ?? 90;
  const mail = legal ? `eine E-Mail an <a href="mailto:${escapeHtml(legal.email)}">${escapeHtml(legal.email)}</a>` : "eine Nachricht an den Verantwortlichen";
  return page(
    "Datenschutzhinweis",
    `<h2>Verantwortlich</h2>
${legal ? contact(legal) : notConfigured}

<h2>Welche Daten verarbeitet werden</h2>
<ul>
<li>Discord-ID, Discord-Benutzername und Anzeigename (Server-Nickname, sonst globaler Anzeigename), dazu der Zeitpunkt des letzten Logins</li>
<li>selbst gewählter Spitzname, falls gesetzt</li>
<li>Avatar-Bild (128 Pixel)</li>
<li>Raumteilnahme: Rolle, Würfler oder Zuschauer, Platz in der Zugreihenfolge</li>
<li>Würfe und Spielereignisse im Verlauf des Raums, auch Eingriffe von Hosts</li>
<li>Sitzungs-Cookie für die Anmeldung</li>
<li>IP-Adresse in den Protokollen des Servers, zusammen mit Zeit, aufgerufener Adresse, Statuscode und Nutzer-ID</li>
</ul>
<p>Eine E-Mail-Adresse wird nicht gespeichert. Die Zugangsschlüssel von Discord werden nach der Anmeldung verworfen.</p>

<h2>Zweck</h2>
<p>Die Daten dienen der Durchführung des Würfelspiels und dem Schutz vor Missbrauch. Die IP-Adresse wird nur für die Protokolle und für die Begrenzung zu vieler Anfragen verwendet.</p>

<h2>Rechtsgrundlage</h2>
<p><strong>Vom Betreiber zu ergänzen: Rechtsgrundlage für die Spieldaten, die Protokolle und die Schutzdienste.</strong></p>

<h2>Anmeldung über Discord</h2>
<p>Die Anmeldung läuft über Discord (Discord Inc., USA). Dafür wird der Browser auf die Webseite von Discord weitergeleitet. Dort gilt die <a href="https://discord.com/privacy">Datenschutzerklärung von Discord</a>.</p>
<p>Nach der Anmeldung übermittelt Discord der App Profildaten des Kontos und der Mitgliedschaft auf dem Discord-Server der Veranstaltung. Die App übernimmt davon nur Discord-ID, Benutzernamen, Anzeigenamen und Avatar und prüft, ob das Konto Mitglied dieses Servers ist. Alles andere verwirft sie sofort. Zugang haben nur Mitglieder dieses Servers. Abgewiesene Anmeldungen werden im Protokoll vermerkt, ohne Discord-Daten.</p>
<p>Avatar-Bilder holt der Server selbst bei Discord ab und liefert sie aus. Der Browser nimmt nur während der Anmeldung Kontakt zu Discord auf.</p>

<h2>Wer was sieht</h2>
<p>Angemeldete Personen in einem Raum sehen von den anderen Teilnehmern Anzeigename oder Spitzname, Avatar, Rolle, Verbindungsstatus und Würfe. Hosts sehen zusätzlich den Discord-Namen und können Spitznamen zurücksetzen.</p>
<p>Ein Host kann für einen Raum einen Zuschauer-Link einschalten. Dann sehen auch Personen ohne Anmeldung den Spielverlauf mit den Anzeigenamen der Würfler, aber ohne Avatare, Discord-IDs und Benutzernamen. Solange der Link aktiv ist, zeigt der Raum einen Hinweis.</p>
<p>Emoji-Reaktionen erscheinen ohne Namen bei allen im Raum und werden nicht gespeichert.</p>

<h2>Cookies und lokaler Speicher</h2>
<p>Die App selbst setzt nur technisch notwendige Cookies:</p>
<ul>
<li><code>__Host-dice_session</code>, das Sitzungs-Cookie: hält die Anmeldung aufrecht und läuft nach 7 Tagen ab</li>
<li><code>dice_login</code>, nur während der Anmeldung bei Discord: sichert den Anmeldevorgang ab, gilt höchstens 10 Minuten und wird danach gelöscht</li>
</ul>${services.cloudflare ? "\n<p>Dazu kann Cloudflare eigene Cookies setzen (siehe unten).</p>" : ""}
<p>Im lokalen Speicher des Browsers (localStorage) merkt sich die App nur Einstellungen: Ton, helles oder dunkles Design und ausgeblendete Reaktionen. Diese Werte bleiben im Browser und werden nicht an den Server gesendet.</p>
<p>Es gibt kein Tracking, keine Analyse und keine Werbung.</p>

${protection(services)}

<h2>Speicherdauer</h2>
<p>Die App löscht beim Start und danach einmal täglich automatisch:</p>
<ul>
<li>Räume samt Teilnahmen, Würfen und Ereignissen ${days} Tage nach der letzten Aktivität im Raum</li>
<li>Nutzer samt Avatar, Spitzname und Sitzungen, wenn sie in keinem Raum mehr Mitglied sind und ihr letzter Login mehr als ${days} Tage zurückliegt</li>
<li>abgelaufene Sitzungen: Sie gelten ab Ablauf nicht mehr und werden beim nächsten täglichen Lauf gelöscht</li>
</ul>
<p>Beim Abmelden löscht die App die Sitzung sofort.</p>
<p>Die Protokolle des Servers liegen außerhalb der App. Ihre Speicherdauer begrenzt der Betreiber auf dem Server.</p>

<h2>Rechte der Betroffenen</h2>
<p>Nach der Datenschutz-Grundverordnung (DSGVO) besteht das Recht auf</p>
<ul>
<li>Auskunft (Art. 15 DSGVO)</li>
<li>Berichtigung (Art. 16 DSGVO)</li>
<li>Löschung (Art. 17 DSGVO)</li>
<li>Einschränkung der Verarbeitung (Art. 18 DSGVO)</li>
<li>Datenübertragbarkeit (Art. 20 DSGVO)</li>
<li>Widerspruch (Art. 21 DSGVO)</li>
</ul>
<p>Dafür genügt ${mail}. Außerdem besteht das Recht auf Beschwerde bei einer Datenschutz-Aufsichtsbehörde (Art. 77 DSGVO).</p>

<p>Stand: ${PRIVACY_UPDATED}</p>`,
  );
}
