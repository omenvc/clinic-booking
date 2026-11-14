// Contract tests for every level of the spec.
// Run against any deployment:
//   BASE_URL=https://your-app.vercel.app API_KEY=... npm test
const { test, before } = require("node:test");
const assert = require("node:assert/strict");

const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const KEY = process.env.API_KEY;

async function req(method, path, { body, headers = {}, key = KEY } = {}) {
  const h = { ...headers };
  if (key !== null) h["X-API-Key"] = key;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, headers: res.headers };
}

const future = (h) => new Date(Date.now() + h * 3600e3).toISOString().replace(/\.\d{3}Z$/, "Z");
const SLOTS = [
  { id: "s2", provider: "Dr Ade", start: future(48), end: future(48.5) },
  { id: "s1", provider: "Dr Ade", start: future(24), end: future(24.5) },
  { id: "s3", provider: "Dr Bello", start: future(30), end: future(30.5) },
  { id: "past", provider: "Dr Bello", start: "2020-01-01T09:00:00Z", end: "2020-01-01T09:30:00Z" },
];
for (let i = 0; i < 30; i++) {
  SLOTS.push({ id: `p${i}`, provider: "Dr Page", start: future(100 + i), end: future(100.5 + i) });
}

let n = 0;
const uniqueEmail = () => `user${Date.now()}_${n++}@example.com`;
const reset = () => req("POST", "/reset", { body: { slots: SLOTS } });

before(async () => {
  assert.ok(KEY, "API_KEY env var is required");
});

test("level 1: reset, list slots, book, get booking", async () => {
  assert.equal((await reset()).status, 200);

  const slots = await req("GET", "/slots");
  assert.equal(slots.status, 200);
  assert.deepEqual(slots.body.slots.map((s) => s.id).slice(0, 4), ["past", "s1", "s3", "s2"]);
  assert.equal(slots.body.slots[1].start, SLOTS[1].start, "start echoed exactly");
  assert.ok(slots.body.slots.every((s) => s.available === true));

  const ade = await req("GET", "/slots?provider=Dr%20Ade");
  assert.deepEqual(ade.body.slots.map((s) => s.id), ["s1", "s2"]);

  const b = await req("POST", "/bookings", { body: { slot_id: "s1", name: "Ada", email: "ada@example.com" } });
  assert.equal(b.status, 201);
  assert.equal(b.body.status, "confirmed");
  for (const f of ["id", "slot_id", "name", "email", "status", "created_at"]) assert.ok(f in b.body, f);

  const got = await req("GET", `/bookings/${b.body.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, b.body);

  assert.equal((await req("GET", "/bookings/nope")).status, 404);
  assert.equal((await req("GET", "/bookings/nope")).body.error.length > 0, true);

  const after = await req("GET", "/slots");
  assert.equal(after.body.slots.find((s) => s.id === "s1").available, false);
});

test("level 2: API key and validation", async () => {
  await reset();
  assert.equal((await req("GET", "/slots", { key: null })).status, 401);
  assert.equal((await req("GET", "/slots", { key: "wrong" })).status, 401);
  assert.equal((await req("POST", "/reset", { key: null, body: { slots: [] } })).status, 401);
  assert.ok((await req("GET", "/slots", { key: null })).body.error);

  const bad = [
    {},
    { slot_id: "s1", name: "A" },
    { slot_id: "s1", email: "a@b.co" },
    { name: "A", email: "a@b.co" },
    { slot_id: "s1", name: "   ", email: "a@b.co" },
    { slot_id: "s1", name: "A", email: "not-an-email" },
    { slot_id: "s1", name: "A", email: "a@b" },
  ];
  for (const body of bad) {
    const r = await req("POST", "/bookings", { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(r.body.error);
  }
  assert.equal((await req("POST", "/bookings", { body: "{not json" })).status, 400);

  assert.equal((await req("POST", "/bookings", { body: { slot_id: "zzz", name: "A", email: uniqueEmail() } })).status, 404);
  assert.equal((await req("POST", "/bookings", { body: { slot_id: "past", name: "A", email: uniqueEmail() } })).status, 400);

  const r = await req("POST", "/bookings", { body: { slot_id: "s1", name: "  Ada Obi  ", email: "  Ada.Obi@Example.COM " } });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, "Ada Obi");
  assert.equal(r.body.email, "ada.obi@example.com");
});

test("level 3: no double booking under concurrency, cancel frees slot", async () => {
  await reset();
  const attempts = await Promise.all(
    Array.from({ length: 20 }, () =>
      req("POST", "/bookings", { body: { slot_id: "s3", name: "Racer", email: uniqueEmail() } })
    )
  );
  const codes = attempts.map((a) => a.status);
  assert.equal(codes.filter((c) => c === 201).length, 1, codes.join(","));
  assert.equal(codes.filter((c) => c === 409).length, 19, codes.join(","));

  const winner = attempts.find((a) => a.status === 201).body;
  const del = await req("DELETE", `/bookings/${winner.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.status, "cancelled");
  assert.equal((await req("DELETE", `/bookings/${winner.id}`)).status, 409);
  assert.equal((await req("DELETE", "/bookings/nope")).status, 404);
  assert.equal((await req("GET", `/bookings/${winner.id}`)).body.status, "cancelled");

  const slots = await req("GET", "/slots");
  assert.equal(slots.body.slots.find((s) => s.id === "s3").available, true);
  assert.equal((await req("POST", "/bookings", { body: { slot_id: "s3", name: "B", email: uniqueEmail() } })).status, 201);
});

test("level 4: idempotency", async () => {
  await reset();
  const body = { slot_id: "s1", name: "Ada", email: uniqueEmail() };
  const headers = { "Idempotency-Key": "key-123" };
  const results = await Promise.all(Array.from({ length: 5 }, () => req("POST", "/bookings", { body, headers })));
  for (const r of results) {
    assert.equal(r.status, 201);
    assert.equal(r.body.id, results[0].body.id);
  }
  const again = await req("POST", "/bookings", { body: { email: body.email, name: body.name, slot_id: body.slot_id }, headers });
  assert.equal(again.status, 201);
  assert.equal(again.body.id, results[0].body.id);

  const list = await req("GET", `/bookings?email=${encodeURIComponent(body.email)}`);
  assert.equal(list.body.bookings.length, 1, "only one booking created");

  const diff = await req("POST", "/bookings", { body: { ...body, slot_id: "s2" }, headers });
  assert.equal(diff.status, 422);
  assert.ok(diff.body.error);
});

test("level 4: paging through a person's bookings", async () => {
  await reset();
  const email = uniqueEmail();
  const ids = [];
  // 5 bookings stays within the per-email rate limit.
  for (let i = 0; i < 5; i++) {
    const r = await req("POST", "/bookings", { body: { slot_id: `p${i}`, name: "Pager", email } });
    assert.equal(r.status, 201);
    ids.push(r.body.id);
  }
  await req("POST", "/bookings", { body: { slot_id: "p20", name: "Other", email: uniqueEmail() } });

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const q = `/bookings?email=${encodeURIComponent(email.toUpperCase())}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await req("GET", q);
    assert.equal(r.status, 200);
    assert.ok(r.body.bookings.length <= 2);
    seen.push(...r.body.bookings.map((b) => b.id));
    cursor = r.body.next_cursor;
    pages++;
  } while (cursor);
  assert.deepEqual(seen, ids, "oldest first, no gaps or repeats");
  assert.equal(pages, 3);

  const def = await req("GET", `/bookings?email=${encodeURIComponent(email)}`);
  assert.equal(def.body.bookings.length, 5);
  assert.equal(def.body.next_cursor, null);

  for (const limit of ["0", "51", "abc", "-1", "2.5"]) {
    assert.equal((await req("GET", `/bookings?email=${encodeURIComponent(email)}&limit=${limit}`)).status, 400, limit);
  }
  assert.equal((await req("GET", `/bookings?email=${encodeURIComponent(email)}&limit=50`)).status, 200);
  assert.equal((await req("GET", `/bookings?email=${encodeURIComponent(email)}&limit=1`)).status, 200);
});

test("level 5: rate limit per email", async () => {
  await reset();
  const email = uniqueEmail();
  const codes = [];
  for (let i = 0; i < 5; i++) {
    // mix of failures (bad slot) and successes; all count
    const r = await req("POST", "/bookings", { body: { slot_id: i % 2 ? "nope" : `p${i}`, name: "Spam", email } });
    codes.push(r.status);
  }
  assert.ok(!codes.includes(429), codes.join(","));
  const sixth = await req("POST", "/bookings", { body: { slot_id: "p10", name: "Spam", email: email.toUpperCase() } });
  assert.equal(sixth.status, 429);
  assert.ok(sixth.body.error);
  const ra = Number(sixth.headers.get("retry-after"));
  assert.ok(Number.isInteger(ra) && ra >= 1 && ra <= 60, `Retry-After=${ra}`);

  const other = await req("POST", "/bookings", { body: { slot_id: "p11", name: "Fine", email: uniqueEmail() } });
  assert.equal(other.status, 201, "other emails unaffected");
});
