// Tiny RFC 4180 CSV reader for the seed files in seed/out. Shared by the local feature producer,
// the evaluation script and the tests so they all read the seed identically.
import fs from "node:fs";
import path from "node:path";

export const SEED_DIR = path.join(import.meta.dirname, "..", "..", "seed", "out");

export function parseCsv(text) {
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function readCsv(file) {
  const rows = parseCsv(fs.readFileSync(path.join(SEED_DIR, file), "utf8"));
  const header = rows[0];
  return rows.slice(1)
    .filter((r) => r.length > 1 || r[0] !== "")
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}
