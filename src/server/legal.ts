// Server-rendered legal pages (spec 9.1, 9.2). All content comes from the LEGAL_* configuration.
import type { Legal } from "./config.js";

export const REPO_URL = "https://github.com/jp1337/dice";

const escapeHtml = (text: string) =>
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

// shortcut: placeholder until the full privacy notice is written in step 2 (spec 9.2), before the first real login.
export function datenschutzHtml(legal: Legal | null) {
  return page(
    "Datenschutzhinweis",
    `<h2>Verantwortlich</h2>
${legal ? contact(legal) : notConfigured}
<p>Der vollständige Datenschutzhinweis folgt, bevor die Anmeldung über Discord freigeschaltet wird.</p>`,
  );
}
