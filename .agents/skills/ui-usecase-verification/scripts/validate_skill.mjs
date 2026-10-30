#!/usr/bin/env node
/**
 * Validate local skill structure without requiring Python/PyYAML.
 *
 * Usage: node .agents/skills/ui-usecase-verification/scripts/validate_skill.mjs <skill-dir>
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const skillPath = resolve(root, "SKILL.md");
const text = await readFile(skillPath, "utf8");
const match = text.match(/^---\n([\s\S]*?)\n---\n/);
if (!match) throw new Error("SKILL.md has no YAML frontmatter");
const field = (name) => {
  const result = match[1].match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
  return result?.[1]?.replace(/^["']|["']$/g, "").trim();
};
const name = field("name");
const description = field("description");
if (!name || !/^[a-z0-9-]+$/.test(name)) {
  throw new Error("name must be lowercase hyphen-case");
}
if (!description || /\[TODO:/.test(description)) {
  throw new Error("description is missing or unfinished");
}
if (/\[TODO:/.test(text)) throw new Error("SKILL.md contains an unfinished TODO");

for (const relative of [
  "references/usecase-template.md",
  "references/geometry-signals.md",
  "references/evidence-matrix.md"
]) {
  await readFile(resolve(root, relative), "utf8");
}
const agents = await readdir(resolve(root, "agents"));
if (!agents.includes("openai.yaml")) throw new Error("missing agents/openai.yaml");

console.log(JSON.stringify({
  valid: true,
  name,
  descriptionLength: description.length,
  references: 3
}));
