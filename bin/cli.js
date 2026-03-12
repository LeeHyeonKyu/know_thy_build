#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(__dirname, "..", "templates");

const LANG_OPTIONS = [
  { key: "en", label: "English" },
  { key: "ko", label: "Korean (한국어)" },
  { key: "ja", label: "Japanese (日本語)" },
  { key: "zh", label: "Chinese (中文)" },
  { key: "es", label: "Spanish (Español)" },
  { key: "fr", label: "French (Français)" },
  { key: "de", label: "German (Deutsch)" },
  { key: "pt", label: "Portuguese (Português)" },
];

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function askLanguage() {
  console.log("\n  What language should know-thy-build use?\n");
  for (let i = 0; i < LANG_OPTIONS.length; i++) {
    const opt = LANG_OPTIONS[i];
    const marker = i === 0 ? " (default)" : "";
    console.log(`    ${i + 1}) ${opt.label}${marker}`);
  }
  console.log(`    9) Other`);

  const answer = await prompt("\n  > ");

  if (!answer) return LANG_OPTIONS[0].label;

  const num = parseInt(answer, 10);
  if (num >= 1 && num <= LANG_OPTIONS.length) {
    return LANG_OPTIONS[num - 1].label;
  }
  if (num === 9) {
    const custom = await prompt("  Enter language name: ");
    return custom || LANG_OPTIONS[0].label;
  }

  const lower = answer.toLowerCase();
  const match = LANG_OPTIONS.find(
    (o) => o.key === lower || o.label.toLowerCase().startsWith(lower)
  );
  return match ? match.label : answer;
}

function installDir(srcDir, destDir, lang) {
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  const entries = readdirSync(srcDir);

  for (const entry of entries) {
    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);

    if (statSync(srcPath).isDirectory()) {
      installDir(srcPath, destPath, lang);
    } else if (entry.endsWith(".md")) {
      let content = readFileSync(srcPath, "utf-8");
      content = content.replaceAll("{{LANG}}", lang);
      writeFileSync(destPath, content, "utf-8");
    }
  }
}

function install(lang, global) {
  const commandsDir = global
    ? join(homedir(), ".claude", "commands")
    : join(process.cwd(), ".claude", "commands");

  installDir(templatesDir, commandsDir, lang);

  const scope = global ? "globally (~/.claude/commands/)" : "in this project";
  console.log(`
  Done! Installed ${scope} (${lang})

  Open Claude Code and run:

    /know-thy-build:project    Define your project
    /know-thy-build:feature    Design a feature
`);
}

// --- Main ---

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
  know-thy-build - Socratic project definition tool

  Usage:
    npx know-thy-build              Install in current project
    npx know-thy-build --global     Install globally (~/.claude/commands/)
    npx know-thy-build --lang ko    Skip language prompt

  Options:
    --global, -g    Install to ~/.claude/commands/ (available in all projects)
    --lang, -l      Language shortcut: ko, en, ja, zh, es, fr, de, pt
`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf-8")
  );
  console.log(pkg.version);
  process.exit(0);
}

const global = args.includes("--global") || args.includes("-g");

let lang = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--lang" || args[i] === "-l") {
    lang = args[++i];
    break;
  }
  if (args[i].startsWith("--lang=")) {
    lang = args[i].split("=")[1];
    break;
  }
}

if (lang) {
  const lower = lang.toLowerCase();
  const match = LANG_OPTIONS.find((o) => o.key === lower);
  install(match ? match.label : lang, global);
} else {
  askLanguage().then((chosen) => install(chosen, global));
}
