module.exports = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clinic Booking</title>
<style>
  :root {
    --bg: #f5f7f6; --card: #fff; --ink: #1d2b27; --muted: #63736e;
    --line: #dde4e1; --brand: #0f766e; --brand-ink: #fff; --bad: #b42318; --ok: #067647;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); }
  header { background: var(--brand); color: var(--brand-ink); padding: 20px 24px; }
  header h1 { margin: 0; font-size: 20px; }
  header p { margin: 4px 0 0; opacity: .85; font-size: 14px; }
  main { max-width: 860px; margin: 24px auto; padding: 0 16px; display: grid; gap: 20px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; }
  h2 { margin: 0 0 12px; font-size: 17px; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  select, input { font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
  button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--brand); background: var(--brand); color: var(--brand-ink); cursor: pointer; }
  button.secondary { background: #fff; color: var(--brand); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
  .slot { border: 1px solid var(--line); border-radius: 10px; padding: 12px; text-align: left; background: #fff; color: var(--ink); }
  .slot.available:hover { border-color: var(--brand); }
  .slot.selected { border-color: var(--brand); box-shadow: 0 0 0 2px var(--brand) inset; }
  .slot.taken { opacity: .55; cursor: not-allowed; }
  .slot .who { font-weight: 600; }
  .slot .when { color: var(--muted); font-size: 13px; }
  .tag { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 99px; margin-top: 6px; }
  .tag.free { background: #e6f4ef; color: var(--ok); }
  .tag.booked { background: #f2f4f3; color: var(--muted); }
  form { display: grid; gap: 10px; max-width: 420px; }
  label { display: grid; gap: 4px; font-size: 14px; color: var(--muted); }
  .msg { padding: 10px 12px; border-radius: 8px; font-size: 14px; }
  .msg.error { background: #fef3f2; color: var(--bad); }
  .confirm { border-left: 4px solid var(--ok); }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
  dt { color: var(--muted); }
  dd { margin: 0; word-break: break-all; }
  .empty { color: var(--muted); }
  .hidden { display: none; }
</style>
</head>
<body>
<header>
  <h1>Clinic Booking</h1>
  <p>Pick a free appointment slot, enter your details, and book.</p>
</header>
<main>
  <section class="card">
    <h2>1. Choose a slot</h2>
    <div class="toolbar">
      <select id="provider"><option value="">All providers</option></select>
      <button class="secondary" id="refresh" type="button">Refresh</button>
    </div>
    <div id="slots" class="slots"><p class="empty">Loading slots...</p></div>
  </section>

  <section class="card">
    <h2>2. Your details</h2>
    <form id="book-form">
      <div id="chosen" class="empty">No slot selected yet.</div>
      <label>Full name <input id="name" autocomplete="name" required></label>
      <label>Email <input id="email" type="email" autocomplete="email" required></label>
      <button id="book-btn" type="submit" disabled>Book appointment</button>
      <div id="book-msg" class="msg error hidden"></div>
    </form>
  </section>

  <section id="confirmation" class="card confirm hidden">
    <h2>Booking confirmed</h2>
    <dl id="confirm-details"></dl>
    <p class="empty">Keep your booking ID to look it up later.</p>
  </section>

  <section class="card">
    <h2>Look up a booking</h2>
    <form id="lookup-form">
      <label>Booking ID <input id="lookup-id" required></label>
      <button type="submit">Look up</button>
      <div id="lookup-msg" class="msg error hidden"></div>
    </form>
    <dl id="lookup-details" class="hidden" style="margin-top:14px"></dl>
  </section>
</main>

<script>
const API = "/web-api";
let slots = [];
let selected = null;

const $ = (id) => document.getElementById(id);
const fmt = (iso) => new Date(iso).toLocaleString(undefined, {
  weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
});

async function call(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "Request failed (" + res.status + ")");
    err.status = res.status;
    err.retryAfter = res.headers.get("Retry-After");
    throw err;
  }
  return data;
}

function showMsg(el, text) {
  el.textContent = text;
  el.classList.toggle("hidden", !text);
}

function details(el, b, slot) {
  const rows = [
    ["Booking ID", b.id],
    ["Status", b.status],
    ["Name", b.name],
    ["Email", b.email],
    ["Slot", slot ? slot.provider + ", " + fmt(slot.start) : b.slot_id],
    ["Booked at", fmt(b.created_at)],
  ];
  el.innerHTML = "";
  for (const [k, v] of rows) {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    el.append(dt, dd);
  }
}

function renderSlots() {
  const filter = $("provider").value;
  const list = slots.filter((s) => !filter || s.provider === filter);
  const box = $("slots");
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = '<p class="empty">No slots to show.</p>';
    return;
  }
  for (const s of list) {
    const past = new Date(s.start) <= new Date();
    const free = s.available && !past;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "slot " + (free ? "available" : "taken") + (selected && selected.id === s.id ? " selected" : "");
    btn.disabled = !free;
    btn.innerHTML = '<div class="who"></div><div class="when"></div><span class="tag"></span>';
    btn.querySelector(".who").textContent = s.provider;
    btn.querySelector(".when").textContent = fmt(s.start) + " to " + new Date(s.end).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const tag = btn.querySelector(".tag");
    tag.textContent = free ? "Available" : past ? "Past" : "Booked";
    tag.classList.add(free ? "free" : "booked");
    btn.onclick = () => { selected = s; renderSlots(); renderChosen(); };
    box.append(btn);
  }
}

function renderChosen() {
  $("chosen").textContent = selected
    ? "Selected: " + selected.provider + ", " + fmt(selected.start)
    : "No slot selected yet.";
  $("chosen").className = selected ? "" : "empty";
  $("book-btn").disabled = !selected;
}

async function loadSlots() {
  try {
    const data = await call("/slots");
    slots = data.slots;
    const providers = [...new Set(slots.map((s) => s.provider))];
    const sel = $("provider");
    const current = sel.value;
    sel.innerHTML = '<option value="">All providers</option>';
    for (const p of providers) {
      const o = document.createElement("option"); o.value = p; o.textContent = p; sel.append(o);
    }
    sel.value = providers.includes(current) ? current : "";
    if (selected) selected = slots.find((s) => s.id === selected.id && s.available) || null;
    renderSlots(); renderChosen();
  } catch (e) {
    $("slots").innerHTML = '<p class="msg error"></p>';
    $("slots").firstChild.textContent = e.message;
  }
}

$("provider").onchange = renderSlots;
$("refresh").onclick = loadSlots;

$("book-form").onsubmit = async (ev) => {
  ev.preventDefault();
  if (!selected) return;
  showMsg($("book-msg"), "");
  $("book-btn").disabled = true;
  try {
    const booking = await call("/bookings", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ slot_id: selected.id, name: $("name").value, email: $("email").value }),
    });
    details($("confirm-details"), booking, selected);
    $("confirmation").classList.remove("hidden");
    $("confirmation").scrollIntoView({ behavior: "smooth" });
    selected = null;
  } catch (e) {
    let text = e.message;
    if (e.status === 429 && e.retryAfter) text += " (wait " + e.retryAfter + "s)";
    showMsg($("book-msg"), text);
  }
  await loadSlots();
};

$("lookup-form").onsubmit = async (ev) => {
  ev.preventDefault();
  showMsg($("lookup-msg"), "");
  $("lookup-details").classList.add("hidden");
  try {
    const id = $("lookup-id").value.trim();
    const b = await call("/bookings/" + encodeURIComponent(id));
    details($("lookup-details"), b, slots.find((s) => s.id === b.slot_id));
    $("lookup-details").classList.remove("hidden");
  } catch (e) {
    showMsg($("lookup-msg"), e.message);
  }
};

loadSlots();
</script>
</body>
</html>`;
