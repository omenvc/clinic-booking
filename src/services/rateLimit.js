const { RATE_LIMIT, RATE_WINDOW_SECONDS } = require("../config");
const { fail } = require("../lib/errors");

// Level 5: at most RATE_LIMIT booking attempts per email in a sliding
// 60-second window. Failed attempts count too. The count lives in Postgres,
// so the limit holds across every server instance.
//
// The per-email lock makes simultaneous attempts for one email queue up, so
// they can't all read "4 attempts" at once and slip past the limit.
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

module.exports = { checkRateLimit };
