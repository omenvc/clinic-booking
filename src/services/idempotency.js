const crypto = require("crypto");

// Level 4: a retried request with the same Idempotency-Key and body gets the
// same response and never creates a second booking. The same key with a
// different body gets a 422.

// Stable JSON, so {"a":1,"b":2} and {"b":2,"a":1} count as the same body.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const hashBody = (body) =>
  crypto.createHash("sha256").update(canonical(body ?? null)).digest("hex");

// Runs `work` at most once per key. A per-key lock makes simultaneous retries
// wait for the first request to finish; they then replay its stored response.
async function withIdempotency(db, key, body, work) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 4))", [key]);
  const hash = hashBody(body);

  const existing = await db.query(
    "SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = $1",
    [key]
  );
  if (existing.rowCount) {
    const saved = existing.rows[0];
    if (saved.request_hash !== hash) {
      return {
        status: 422,
        body: { error: "Idempotency-Key was already used with a different request body" },
      };
    }
    return { status: saved.status_code, body: saved.response };
  }

  const result = await work();

  // Don't store a rate-limit rejection: a later retry should get a real answer.
  if (result.status !== 429) {
    await db.query(
      `INSERT INTO idempotency_keys (key, request_hash, status_code, response)
       VALUES ($1, $2, $3, $4)`,
      [key, hash, result.status, JSON.stringify(result.body)]
    );
  }
  return result;
}

module.exports = { withIdempotency };
