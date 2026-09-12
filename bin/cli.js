#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  unlinkSync,
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

// know-thy-build/finish.md은 하위 경로다 — join(commandsDir, file)이 "/"를 그대로 세그먼트로
// 다뤄 commandsDir/know-thy-build/finish.md를 정확히 가리키므로 cleanLegacy는 플랫 이름과
// 하위 경로 이름을 구분 없이 다룬다.
const LEGACY_FILES = ["know-thy-build.md", "know-thy-build-evolve.md", "know-thy-build/finish.md"];

function cleanLegacy(commandsDir) {
  let cleaned = [];
  for (const file of LEGACY_FILES) {
    const filePath = join(commandsDir, file);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      cleaned.push(file);
    }
  }
  return cleaned;
}

function install(lang, global) {
  const commandsDir = global
    ? join(homedir(), ".claude", "commands")
    : join(process.cwd(), ".claude", "commands");

  const cleaned = cleanLegacy(commandsDir);
  // templates/ 루트에는 know-thy-build/(스킬)와 factory/(factory init이 따로 설치하는 자료)가
  // 나란히 있다 — 여기서 templatesDir 전체를 복사하면 factory/**의 .md들(agents/commands/lessons/
  // CHARTER)까지 .claude/commands/factory/로 새어 들어간다. 스킬 설치기는 know-thy-build/만 본다.
  installDir(join(templatesDir, "know-thy-build"), join(commandsDir, "know-thy-build"), lang);

  const scope = global ? "globally (~/.claude/commands/)" : "in this project";
  if (cleaned.length > 0) {
    console.log(`\n  Cleaned up legacy commands: ${cleaned.join(", ")}`);
  }
  console.log(`
  Done! Installed ${scope} (${lang})

  Pipeline (13 skills — one per human decision point):

    Define (5):
      /know-thy-build:project      Define what and why
      /know-thy-build:technical    Define how to build
      /know-thy-build:qa           QA framework + test the product
      /know-thy-build:feature      Design a feature before building it
      /know-thy-build:issue        Log a bug/chore/small change (no spec doc)

      Design helpers (invoked from :feature):
        /know-thy-build:architect    Code structure (stubs, tests)
        /know-thy-build:designer     UX design intent (UI features)

    Operate (8 — require \`factory init\`):
      /know-thy-build:harness      Fix a failing doctor / adopt a brownfield repo
      /know-thy-build:next         Pick the next issue to queue
      /know-thy-build:clarify      Answer needs-info questions on a spec
      /know-thy-build:unstick      Resolve a stuck issue (needs-human)
      /know-thy-build:proposal     Review a retro/harness proposal PR
      /know-thy-build:role         Create or edit a reviewer/plan role
      /know-thy-build:digest       Weekly summary of what shipped
      /know-thy-build:status       Read-only dashboard (Needs You / in progress / queue)

  Start with /know-thy-build:project
`);
}

// --- Main ---

const args = process.argv.slice(2);

if (args[0] === "factory") {
  const { main } = await import("../factory/cli/index.js");
  process.exit(await main(args.slice(1)));
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
  know-thy-build — Multi-agent project definition & QA framework for Claude Code

  Usage:
    npx know-thy-build              Install in current project
    npx know-thy-build --global     Install globally (~/.claude/commands/)
    npx know-thy-build --lang ko    Skip language prompt
    npx know-thy-build factory <init|doctor|bootstrap|run|status>   Phase 2 — see \`factory --help\`

  Commands installed (13 skills — one per human decision point):
    Define:
      :project     Define what and why                → docs/PROJECT.md + CLAUDE.md + hooks
      :technical   Define how to build                → docs/TECHNICAL.md
      :qa          QA framework + test the product     → docs/QA.md
      :feature     Design a feature before building it → docs/features/NNN.md + issue
      :issue       Log a bug/chore/small change         → issue only, no spec doc
      :architect   Code structure (stubs, tests)        → scaffold + signature tests
      :designer    UX design intent (UI features)       → design intent in feature spec

    Operate (require \`factory init\`):
      :harness     Fix a failing doctor / adopt a brownfield repo
      :next        Pick the next issue to queue
      :clarify     Answer needs-info questions on a spec
      :unstick     Resolve a stuck issue (needs-human)
      :proposal    Review a retro/harness proposal PR
      :role        Create or edit a reviewer/plan role
      :digest      Weekly summary of what shipped
      :status      Read-only dashboard (Needs You / in progress / queue)

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
