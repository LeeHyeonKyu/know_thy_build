export function parseMarkers(stdout) {
  const out = {};
  for (const line of String(stdout).split("\n")) { const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim()); if (m) out[m[1]] = m[2]; }
  return out;
}
