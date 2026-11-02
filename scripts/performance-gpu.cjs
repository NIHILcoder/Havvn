/* eslint-disable @typescript-eslint/no-require-imports -- Shared Windows collector command. */
function gpuPidAssignment(file) {
  const quoted = "'" + file.replace(/'/g, "''") + "'";
  // Windows PowerShell 5.1 wraps the JSON array if @() surrounds this pipeline.
  // A direct assignment preserves its numeric elements for -contains.
  return `$ids=Get-Content -LiteralPath ${quoted} -Raw | ConvertFrom-Json;`;
}
module.exports = { gpuPidAssignment };
