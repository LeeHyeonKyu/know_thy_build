#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(__dirname, "..", "templates");
const targetDir = process.cwd();
const COMMANDS_DIR = join(targetDir, ".claude", "commands");

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

  // Try matching by key or label
  const lower = answer.toLowerCase();
  const match = LANG_OPTIONS.find(
    (o) => o.key === lower || o.label.toLowerCase().startsWith(lower)
  );
  return match ? match.label : answer;
}

function install(lang) {
  if (!existsSync(COMMANDS_DIR)) {
    mkdirSync(COMMANDS_DIR, { recursive: true });
  }

  const templates = readdirSync(templatesDir).filter((f) => f.endsWith(".md"));

  for (const file of templates) {
    const src = join(templatesDir, file);
    let content = readFileSync(src, "utf-8");
    content = content.replaceAll("{{LANG}}", lang);
    const dest = join(COMMANDS_DIR, file);
    writeFileSync(dest, content, "utf-8");
  }

  console.log(`
  Done! (${lang})

  Open Claude Code in this project and run:

    /know-thy-build
`);
}

// --- Main ---

const args = process.argv.slice(2);
const command = args[0];

if (command === "--help" || command === "-h") {
  console.log(`
  know-thy-build - Socratic project project definition tool

  Usage:
    npx know-thy-build              Interactive setup
    npx know-thy-build --lang ko    Skip language prompt

  Language shortcuts: ko, en, ja, zh, es, fr, de, pt
`);
  process.exit(0);
}

if (command === "--version" || command === "-v") {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf-8")
  );
  console.log(pkg.version);
  process.exit(0);
}

// If --lang provided, skip prompt
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
  install(match ? match.label : lang);
} else {
  askLanguage().then((chosen) => install(chosen));
}
