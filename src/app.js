const crypto = require("crypto");
const express = require("express");
const { pool, ensureSchema } = require("./db");
const PAGE_HTML = require("./page");

const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  throw new Error("API_KEY is not set");
}

const RATE_LIMIT = 5; // booking attempts per email
const RATE_WINDOW_SECONDS = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const fail = (status, message, headers) => {
  throw new HttpError(status, message, headers);
};

function toBooking(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toSlot(row) {
  return {
    id: row.id,
    provider: row.provider,
    start: row.start_raw,
    end: row.end_raw,
    available: row.available,
  };
}

// Stable JSON so {"a":1,"b":2} and {"b":2,"a":1} count as the same body.
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

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const encodeCursor = (seq) => Buffer.from(`b:${seq}`).toString("base64url");
function decodeCursor(cursor) {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const m = /^b:(\d+)$/.exec(raw);
  if (!m) fail(400, "cursor is invalid");
  return m[1];
}

// ---------- core logic ----------

// Every booking request runs in ONE transaction on ONE connection, and all
// locks are transaction-scoped (pg_advisory_xact_lock), so they are released
// on COMMIT/ROLLBACK even behind a connection pooler.

// Level 5: at most RATE_LIMIT attempts per email in a sliding window.
// Every attempt that gets past this check counts, whether it then succeeds or fails.
async function checkRateLimit(db, email) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 5))", [`rl:${email}`]);
  const { rows } = await db.query(
    `SELECT count(*)::int AS n,
            EXTRACT(EPOCH FROM (min(at) + make_interval(secs => $2) - clock_timestamp())) AS wait
       FROM booking_attempts
      WHERE email = $1 AND at > clock_timestamp() - make_interval(secs => $2)`,
    [email, RATE_WINDOW_SECONDS]
  );
  if (rows[0].n >= RATE_LIMIT) {
    const retryAfter = Math.max(1, Math.ceil(Number(rows[0].wait)));
    fail(429, "Too many booking attempts for this email. Try again later.", {
      "Retry-After": String(retryAfter),
    });
  }
  await db.query("INSERT INTO booking_attempts (email) VALUES ($1)", [email]);
}

async function bookSlot(db, body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};

  // Rate limit first, so invalid attempts count too.
  if (typeof b.email === "string" && b.email.trim()) {
    await checkRateLimit(db, b.email.trim().toLowerCase());
  }

  for (const field of ["slot_id", "name", "email"]) {
    if (typeof b[field] !== "string" || !b[field].trim()) {
      fail(400, `${field} is required`);
    }
  }
  const slotId = b.slot_id.trim();
  const name = b.name.trim();
  const email = b.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) fail(400, "email is invalid");

  const slot = await db.query(
    "SELECT id, start_at <= now() AS started FROM slots WHERE id = $1",
    [slotId]
  );
  if (slot.rowCount === 0) fail(404, "Slot not found");
  if (slot.rows[0].started) fail(400, "This slot has already started");

  // Level 3: the partial unique index lets only one confirmed booking per slot
  // exist. A savepoint keeps the transaction usable if the insert loses the race.
  await db.query("SAVEPOINT book");
  try {
    const { rows } = await db.query(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES ($1, $2, $3, $4, 'confirmed')
       RETURNING *`,
      [crypto.randomUUID(), slotId, name, email]
    );
    await db.query("RELEASE SAVEPOINT book");
    return { status: 201, body: toBooking(rows[0]) };
  } catch (err) {
    await db.query("ROLLBACK TO SAVEPOINT book");
    if (err.code === "23505") fail(409, "This slot is already booked");
    throw err;
  }
}

// Turns an HttpError into a stored-able result instead of an exception, so
// the transaction still commits (and failed attempts still count).
async function attempt(db, body) {
  try {
    return await bookSlot(db, body);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return { status: err.status, body: { error: err.message }, headers: err.headers };
  }
}

// Level 4: the same Idempotency-Key + body always gets the same response and
// never makes a second booking. The per-key lock makes concurrent retries
// wait for the first one to commit, then they replay its stored response.
async function handleBooking(db, key, body) {
  if (key !== undefined) {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 4))", [key]);
    const hash = sha256(canonical(body ?? null));
    const existing = await db.query(
      "SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = $1",
      [key]
    );
    if (existing.rowCount) {
      const row = existing.rows[0];
      if (row.request_hash !== hash) {
        return {
          status: 422,
          body: { error: "Idempotency-Key was already used with a different request body" },
        };
      }
      return { status: row.status_code, body: row.response };
    }
    const result = await attempt(db, body);
    // Don't store rate-limit rejections: a later retry should get a real answer.
    if (result.status !== 429) {
      await db.query(
        `INSERT INTO idempotency_keys (key, request_hash, status_code, response)
         VALUES ($1, $2, $3, $4)`,
        [key, hash, result.status, JSON.stringify(result.body)]
      );
    }
    return result;
  }
  return attempt(db, body);
}

// ---------- routes ----------

const api = express.Router();

api.use((req, res, next) => {
  const key = req.get("X-API-Key");
  if (!key || !safeEqual(key, API_KEY)) {
    return res.status(401).json({ error: "Missing or invalid API key" });
  }
  next();
});

api.post("/reset", async (req, res) => {
  const slots = req.body && req.body.slots;
  if (!Array.isArray(slots)) fail(400, "slots must be an array");

  const seen = new Set();
  const clean = slots.map((s, i) => {
    if (!s || typeof s !== "object") fail(400, `slots[${i}] is invalid`);
    for (const f of ["id", "provider", "start", "end"]) {
      if (typeof s[f] !== "string" || !s[f].trim()) fail(400, `slots[${i}].${f} is required`);
    }
    if (Number.isNaN(Date.parse(s.start)) || Number.isNaN(Date.parse(s.end))) {
      fail(400, `slots[${i}] has an invalid date`);
    }
    if (seen.has(s.id)) fail(400, `Duplicate slot id: ${s.id}`);
    seen.add(s.id);
    return s;
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM bookings");
    await client.query("DELETE FROM idempotency_keys");
    await client.query("DELETE FROM booking_attempts");
    await client.query("DELETE FROM slots");
    if (clean.length) {
      await client.query(
        `INSERT INTO slots (id, provider, start_raw, end_raw, start_at, end_at)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::timestamptz[])`,
        [
          clean.map((s) => s.id),
          clean.map((s) => s.provider),
          clean.map((s) => s.start),
          clean.map((s) => s.end),
          clean.map((s) => new Date(s.start).toISOString()),
          clean.map((s) => new Date(s.end).toISOString()),
        ]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.status(200).json({ status: "ok", slots: clean.length });
});

api.get("/slots", async (req, res) => {
  const provider = typeof req.query.provider === "string" ? req.query.provider : null;
  const { rows } = await pool.query(
    `SELECT s.*,
            NOT EXISTS (SELECT 1 FROM bookings b
                         WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
       FROM slots s
      WHERE $1::text IS NULL OR s.provider = $1
      ORDER BY s.start_at, s.id`,
    [provider]
  );
  res.json({ slots: rows.map(toSlot) });
});

api.post("/bookings", async (req, res) => {
  const key = req.get("Idempotency-Key");
  if (key !== undefined && !key.trim()) fail(400, "Idempotency-Key must not be empty");

  // Retry the whole transaction if Postgres aborts it with a deadlock or
  // serialization failure; the retry is safe because nothing was committed.
  let result;
  for (let attemptNo = 1; ; attemptNo++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      result = await handleBooking(client, key, req.body);
      await client.query("COMMIT");
      break;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (["40P01", "40001"].includes(err.code) && attemptNo < 4) {
        await new Promise((r) => setTimeout(r, 25 * attemptNo + Math.random() * 50));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
  if (result.headers) res.set(result.headers);
  res.status(result.status).json(result.body);
});

api.get("/bookings", async (req, res) => {
  const { email, limit, cursor } = req.query;
  if (typeof email !== "string" || !email.trim()) fail(400, "email is required");

  let n = 10;
  if (limit !== undefined) {
    if (typeof limit !== "string" || !/^\d+$/.test(limit)) fail(400, "limit must be an integer from 1 to 50");
    n = Number(limit);
    if (n < 1 || n > 50) fail(400, "limit must be an integer from 1 to 50");
  }

  let after = "0";
  if (cursor !== undefined && cursor !== "") {
    if (typeof cursor !== "string") fail(400, "cursor is invalid");
    after = decodeCursor(cursor);
  }

  const { rows } = await pool.query(
    `SELECT * FROM bookings
      WHERE email = lower(trim($1)) AND seq > $2
      ORDER BY seq
      LIMIT $3`,
    [email, after, n + 1]
  );
  const page = rows.slice(0, n);
  const next = rows.length > n ? encodeCursor(page[page.length - 1].seq) : null;
  res.json({ bookings: page.map(toBooking), next_cursor: next });
});

api.get("/bookings/:id", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM bookings WHERE id = $1", [req.params.id]);
  if (!rows.length) fail(404, "Booking not found");
  res.json(toBooking(rows[0]));
});

api.delete("/bookings/:id", async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE bookings SET status = 'cancelled'
      WHERE id = $1 AND status = 'confirmed'
      RETURNING *`,
    [req.params.id]
  );
  if (rows.length) return res.json(toBooking(rows[0]));
  const exists = await pool.query("SELECT 1 FROM bookings WHERE id = $1", [req.params.id]);
  if (!exists.rowCount) fail(404, "Booking not found");
  fail(409, "Booking is already cancelled");
});

// ---------- app ----------

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Idempotency-Key",
    "Access-Control-Expose-Headers": "Retry-After",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "1mb" }));

app.use(async (req, res, next) => {
  try {
    await ensureSchema();
    next();
  } catch (err) {
    next(err);
  }
});

// The web page. It talks to the same API through /web-api, where the server
// adds the API key, so the key never ships to the browser.
app.get("/", (req, res) => res.type("html").send(PAGE_HTML));
app.use(
  "/web-api",
  (req, res, next) => {
    req.headers["x-api-key"] = API_KEY;
    next();
  },
  api
);

app.use("/", api);

app.use((req, res) => res.status(404).json({ error: "Not found" }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    if (err.headers) res.set(err.headers);
    return res.status(err.status).json({ error: err.message });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Request body must be valid JSON" });
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

module.exports = app;
