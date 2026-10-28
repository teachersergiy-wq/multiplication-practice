export function sortTeacherCompetitiveRows(rows) {
  return [...rows].sort((a, b) => String(a.fullName).localeCompare(String(b.fullName), "uk", { sensitivity: "base" }));
}

export function competitiveDateTime(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" });
}
