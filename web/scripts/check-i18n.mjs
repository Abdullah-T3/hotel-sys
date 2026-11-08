#!/usr/bin/env node
// Validate translations against the English source dictionary.
//   node scripts/check-i18n.mjs            # all languages
//   node scripts/check-i18n.mjs ar ru      # only these
// Checks: no missing/unknown keys, identical {placeholders}, the plural forms each language needs,
// and the file format (one `"key": "value",` entry per line, JSON-escaped strings).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "i18n");
const PLURALS = { en: ["one", "other"], ar: ["zero", "one", "two", "few", "many", "other"], ru: ["one", "few", "many", "other"],
  tr: ["one", "other"], zh: ["other"], vi: ["other"] };
const SUFFIX = /_(zero|one|two|few|many|other)$/;

function load(lang) {
  const text = readFileSync(join(dir, `${lang}.ts`), "utf8");
  const out = new Map();
  const problems = [];
  for (const [i, line] of text.split("\n").entries()) {
    const m = line.match(/^\s*"([^"]+)":\s*("(?:[^"\\]|\\.)*")\s*,?\s*(\/\/.*)?$/);
    if (!m) {
      if (/^\s*"/.test(line)) problems.push(`line ${i + 1}: cannot parse ${line.trim().slice(0, 60)}`);
      continue;
    }
    if (out.has(m[1])) problems.push(`duplicate key ${m[1]}`);
    try { out.set(m[1], JSON.parse(m[2])); } catch { problems.push(`line ${i + 1}: bad string for ${m[1]}`); }
  }
  return { dict: out, problems };
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const en = load("en").dict;
const plural = new Map(); // base key -> en _other text
const plain = new Map();
for (const [k, v] of en) {
  const base = k.replace(SUFFIX, "");
  if (SUFFIX.test(k)) { if (k.endsWith("_other")) plural.set(base, v); } else plain.set(k, v);
}

const langs = process.argv.slice(2).length ? process.argv.slice(2) : ["ar", "zh", "ru", "tr", "vi"];
let failed = false;
for (const lang of langs) {
  const { dict, problems } = load(lang);
  const errors = [...problems];
  for (const [k, v] of plain) {
    if (!dict.has(k)) errors.push(`missing ${k}`);
    else if (!same(placeholders(dict.get(k)), placeholders(v))) errors.push(`placeholders differ in ${k}: ${JSON.stringify(dict.get(k))}`);
  }
  for (const [base, v] of plural) {
    for (const cat of PLURALS[lang]) {
      const k = `${base}_${cat}`;
      if (!dict.has(k)) { errors.push(`missing ${k}`); continue; }
      const want = placeholders(v), got = placeholders(dict.get(k));
      // zero/one/two forms may spell the number out instead of using {count}
      const relaxed = ["zero", "one", "two"].includes(cat) && same(got, want.filter((p) => p !== "count"));
      if (!same(got, want) && !relaxed) errors.push(`placeholders differ in ${k}: ${JSON.stringify(dict.get(k))}`);
    }
  }
  for (const k of dict.keys()) {
    const base = k.replace(SUFFIX, "");
    const ok = plain.has(k) || (plural.has(base) && PLURALS[lang].some((c) => k === `${base}_${c}`));
    if (!ok) errors.push(`unknown key ${k}`);
  }
  for (const [k, v] of dict) {
    if (!v.trim()) errors.push(`empty ${k}`);
    if (/&(amp|lt|gt|quot|#\d+);/.test(v)) errors.push(`HTML entity in ${k} (write the character itself): ${JSON.stringify(v)}`);
  }
  const total = plain.size + plural.size * PLURALS[lang].length;
  if (errors.length) {
    failed = true;
    console.log(`✗ ${lang}: ${errors.length} problem(s), ${dict.size}/${total} entries`);
    for (const e of errors.slice(0, 40)) console.log("   " + e);
    if (errors.length > 40) console.log(`   … ${errors.length - 40} more`);
  } else {
    console.log(`✓ ${lang}: ${dict.size}/${total} entries OK`);
  }
}
process.exit(failed ? 1 : 0);
