const util = require("util");

const format = (level, message, meta = {}) => {
  const timestamp = new Date().toISOString();
  const metaString =
    meta && Object.keys(meta).length > 0 ? ` ${util.inspect(meta)}` : "";
  return `[${timestamp}] ${level.toUpperCase()} ${message}${metaString}`;
};

module.exports = {
  info(message, meta) {
    console.log(format("info", message, meta));
  },
  warn(message, meta) {
    console.warn(format("warn", message, meta));
  },
  error(message, meta) {
    console.error(format("error", message, meta));
  },
};
