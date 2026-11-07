// Turning a batch's material into one input per job.
export type Split = "file" | "line" | "row";
export const MAX_ITEMS = 50;

/** CSV rows as "column: value" lines, using the first row as the header. Handles quoted cells. */
export function csvRows(text: string): string[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  const [head, ...body] = rows.filter((r) => r.some((x) => x.trim()));
  if (!head) return [];
  return body.map((r) => head.map((h, i) => `${h.trim()}: ${(r[i] ?? "").trim()}`).join("\n"));
}

/** One input per file, per non-empty line, or per CSV row. Pasted text counts as one more source. */
export function itemsOf(split: Split, files: { name: string; text: string }[], pasted: string): string[] {
  if (split === "file") return [...files.map((f) => `--- ${f.name} ---\n${f.text}`), pasted.trim()].filter(Boolean);
  const sources = [...files.map((f) => f.text), pasted].filter((s) => s.trim());
  if (split === "row") return sources.flatMap(csvRows);
  return sources.flatMap((s) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
}
