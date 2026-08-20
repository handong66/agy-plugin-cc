import fs from "node:fs";
import path from "node:path";

export function loadPromptTemplate(rootDir, name) {
  const file = path.join(rootDir, "prompts", `${name}.md`);
  return fs.readFileSync(file, "utf8");
}

export function interpolateTemplate(template, values) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] ?? "") : match
  );
}
