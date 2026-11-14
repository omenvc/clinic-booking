# Clinic Booking API

An API that lets patients book clinic appointment slots, plus a small web page that uses it. Built for Task 1 of the Koya Cohort 4 assessment.

- **Stack:** Node.js, Express 5, PostgreSQL (Neon)
- **Hosting:** Vercel (serverless function), Neon (database)
- **Web page:** served at `/` by the same app

## Project structure

```
api/index.js                  Vercel entry point
server.js                     Local entry point (npm start)
src/
  app.js                      Express setup: CORS, JSON, web page, error handler
  config.js                   API key and limits
  db.js                       Postgres pool and tables (incl. the one-booking-per-slot index)
  page.js                     The booking web page
  middleware/requireApiKey.js Level 2: X-API-Key check
  routes/index.js             Puts every API route behind the key check
  routes/slots.js             POST /reset, GET /slots
  routes/bookings.js          POST/GET /bookings, GET/DELETE /bookings/:id
  services/bookingService.js  Booking rules: validation, no double booking, cancel
  services/idempotency.js     Level 4: Idempotency-Key handling
  services/rateLimit.js       Level 5: 5 attempts per email per minute
  lib/                        Errors, JSON shapes, pagination cursor
test/api.test.js              Tests for all five levels
```

## Endpoints

Every request needs an `X-API-Key` header. Errors always look like `{"error": "<message>"}`.

| Method | Path | Level | What it does |
| --- | --- | --- | --- |
| POST | `/reset` | 1 | Delete all bookings and replace all slots |
| GET | `/slots?provider=` | 1 | List slots by start time, with `available` |
| POST | `/bookings` | 1–5 | Book a slot |
| GET | `/bookings?email=&limit=&cursor=` | 4 | Page through a person's bookings, oldest first |
| GET | `/bookings/{id}` | 1 | Get one booking |
| DELETE | `/bookings/{id}` | 3 | Cancel a booking and free the slot |

## How each level is handled

**Level 1.** Slots and bookings live in Postgres, so data survives between requests and cold starts. Slot times are echoed back exactly as they were sent to `/reset`.

**Level 2.** `middleware/requireApiKey.js` checks `X-API-Key` against the `API_KEY` environment variable using a constant-time compare, and returns 401 if it's missing or wrong. `services/bookingService.js` trims `name` and `email`, lowercases `email`, and returns 400 for missing fields, a bad email or a slot that has already started, and 404 for an unknown slot.

**Level 3.** Double booking is prevented by the database (`db.js`), not by application code. A partial unique index allows only one `confirmed` booking per slot:

```sql
CREATE UNIQUE INDEX one_confirmed_booking_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';
```

If two requests arrive at the same moment, Postgres lets one insert through and rejects the other, which the API turns into a 409. Cancelling sets the status to `cancelled`, which takes the booking out of the index and frees the slot.

**Level 4.** In `services/idempotency.js`: with an `Idempotency-Key` header, the API takes a Postgres advisory lock on that key, so concurrent retries wait for the first request to finish. The first response is stored with a hash of the request body. A repeat with the same body gets the stored response and booking ID; a different body gets 422. Bookings are listed oldest first using an opaque cursor, so pages never skip or repeat a booking even when new ones are added.

**Level 5.** In `services/rateLimit.js`: each email can make 5 booking attempts per minute (sliding window), whether they succeed or fail. The 6th gets a 429 with a `Retry-After` header in seconds. Attempts are counted in Postgres under a per-email lock, so the limit holds across serverless instances and concurrent requests. Other emails are unaffected.

**Web page.** The page calls the API through `/web-api/*`, where the server adds the API key itself, so the key is never sent to the browser.

## Running locally

```bash
npm install
export DATABASE_URL="postgresql://user:pass@host/db"
export API_KEY="choose-a-key"
npm start            # http://localhost:3000
```

Tables are created automatically on the first request.

## Tests

`test/api.test.js` checks every level of the spec, including 20 simultaneous bookings for one slot and concurrent idempotent retries. Point it at any deployment:

```bash
BASE_URL=http://localhost:3000 API_KEY=choose-a-key npm test
```

## Deploying

1. Create a Postgres database on Neon and copy its connection string.
2. Import this repo into Vercel and set `DATABASE_URL` and `API_KEY` as environment variables.
3. Deploy. `vercel.json` sends every route to the Express app in `api/index.js`.
