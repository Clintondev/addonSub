const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function parseAndValidate(file, validate) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (validate && !validate(value)) throw new Error(`Invalid JSON store: ${path.basename(file)}`);
  return value;
}

function readJsonFile(file, { fallback, validate, backup = `${file}.backup` } = {}) {
  try {
    return parseAndValidate(file, validate);
  } catch (error) {
    if (error.code === "ENOENT") {
      try { return parseAndValidate(backup, validate); }
      catch (backupError) {
        if (backupError.code === "ENOENT") return typeof fallback === "function" ? fallback() : fallback;
        throw backupError;
      }
    }
    try { return parseAndValidate(backup, validate); }
    catch (backupError) {
      const failure = new Error(`Could not read ${path.basename(file)} or its backup: ${error.message}; backup: ${backupError.message}`);
      failure.cause = error;
      throw failure;
    }
  }
}

function writeJsonFileAtomic(file, value, { mode = 0o600, backup = `${file}.backup` } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", mode);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2), "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      JSON.parse(fs.readFileSync(file, "utf8"));
      fs.copyFileSync(file, backup);
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch (_) {}
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { readJsonFile, writeJsonFileAtomic };
