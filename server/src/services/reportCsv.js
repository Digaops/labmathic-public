// Spreadsheet-facing text must remain text, including values starting with whitespace.
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
function reportCsv(headers, rows) {
  return '\uFEFF' + [headers.map(csvCell).join(','), ...rows.map(row => Object.values(row).map(csvCell).join(','))].join('\r\n');
}
module.exports = { csvCell, reportCsv };
