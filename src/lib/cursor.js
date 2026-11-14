const { fail } = require("./errors");

// Opaque pagination cursor: the position (seq) of the last booking on a page.
const encodeCursor = (seq) => Buffer.from(`b:${seq}`).toString("base64url");

function decodeCursor(cursor) {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const m = /^b:(\d+)$/.exec(raw);
  if (!m) fail(400, "cursor is invalid");
  return m[1];
}

module.exports = { encodeCursor, decodeCursor };
