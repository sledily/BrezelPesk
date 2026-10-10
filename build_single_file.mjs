import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COURT_ART } from "./src/court-art.js";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(projectRoot, "Dendarv_Play.html");

const sourceOrder = [
  "src/constants.js",
  "src/rng.js",
  "src/notation.js",
  "src/model.js",
  "src/rules.js",
  "src/engine.js",
  "src/projection.js",
  "src/persistence.js",
  "src/format.js",
  "src/online.js",
  "src/browser-notifications.js",
  "src/court-art.js",
  "src/presentation.js",
  "src/tabletop.js",
  "src/event-presentation.js",
  "src/recap.js",
  "src/ui.js",
];

function removeModuleSyntax(source, filename) {
  let bundled = source.replace(/^import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];\s*/gm, "");
  bundled = bundled.replace(/^export\s+(?=(?:async\s+)?function\b|class\b|const\b|let\b|var\b)/gm, "");
  bundled = bundled.replace(/^export\s*\{[^}]*\};?\s*$/gm, "");
  if (/^\s*(?:import|export)\b/m.test(bundled)) {
    throw new Error(`Unprocessed module syntax remains in ${filename}`);
  }
  return `\n/* ${filename} */\n${bundled.trim()}\n`;
}

const application = sourceOrder
  .map((filename) => {
    let source = readFileSync(join(projectRoot, filename), "utf8");
    if (filename === 'src/court-art.js') {
      for (const path of Object.values(COURT_ART)) {
        source = source.replace(path, `data:image/jpeg;base64,${readFileSync(join(projectRoot, path)).toString('base64')}`);
      }
    }
    return removeModuleSyntax(source, filename);
  })
  .join("\n");

const css = ["src/styles.css", "src/court-theme.css"].map(path=>readFileSync(join(projectRoot,path),"utf8")).join('\n');
let html = readFileSync(join(projectRoot, "index.html"), "utf8");

html = html.replace(
  /\s*<link rel="stylesheet" href="\.\/src\/styles\.css">/,
  `\n    <style>\n${css}\n    </style>`,
);
html = html.replace(/\s*<link rel="stylesheet" href="\.\/src\/court-theme\.css">/, '');
html = html.replace(
  /\s*<script type="module" src="\.\/src\/ui\.js"><\/script>/,
  `\n    <script>\n(() => {\n  "use strict";\n${application}\n})();\n    </script>`,
);

if (html.includes("./src/")) throw new Error("The single-file build still has an external source dependency");
writeFileSync(outputPath, html, "utf8");
process.stdout.write(`${outputPath}\n`);
