export type PatientRecord = {
  name: string;
  dob: string;
  patientId: string;
  publicKey: string;
};

const HEADER = ["name", "dob", "patientId", "publicKey"];

function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function recordsToCsv(records: PatientRecord[]): string {
  const lines = [HEADER.join(",")];
  records.forEach((record) => {
    lines.push(
      [record.name, record.dob, record.patientId, record.publicKey].map(escapeCsvField).join(","),
    );
  });
  return lines.join("\n");
}

// Minimal RFC-4180-ish line parser: handles quoted fields with embedded
// commas/newlines/escaped quotes. Good enough for our fixed 4-column schema.
export function parseCsv(text: string): PatientRecord[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows;
  if (!header || header.join(",") !== HEADER.join(",")) return [];
  return body
    .filter((cells) => cells.some((cell) => cell.length))
    .map(([name, dob, patientId, publicKey]) => ({
      name: name ?? "",
      dob: dob ?? "",
      patientId: patientId ?? "",
      publicKey: publicKey ?? "",
    }));
}
