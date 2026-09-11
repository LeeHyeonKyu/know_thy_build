/** 최소 glob → RegExp: ** (any dirs), * (no slash), ? , {a,b} */
export function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") { if (glob[i + 1] === "*") { re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += glob[i + 2] === "/" ? 2 : 1; } else re += "[^/]*"; }
    else if (ch === "?") re += "[^/]";
    else if (ch === "{") { const end = glob.indexOf("}", i); re += "(?:" + glob.slice(i + 1, end).split(",").map(escape).join("|") + ")"; i = end; }
    else re += escape(ch);
  }
  return new RegExp("^" + re + "$");
}
const escape = (s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&");
export const matchesAny = (globs, file) => globs.some((g) => globToRegex(g).test(file));
