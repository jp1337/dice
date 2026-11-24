// Applies a stored light or dark choice before the first paint. A classic script in <head> blocks the
// parser, so it runs before <body> is rendered; served from our own origin, the CSP allows it, where an
// inline script would be blocked. Keep the key in sync with THEME_KEY in src/web/lib/prefs.ts
// (test/web.test.ts checks it).
try {
  const theme = localStorage.getItem("dice.theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {
  // Storage blocked (private mode, policy): the system preference applies.
}
