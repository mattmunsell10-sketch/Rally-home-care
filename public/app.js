/* Rally Care web app. Plain JavaScript, no build step.
   Data model: the server keeps JSON records per care circle (med, dose, task,
   log, expense, shift). This app keeps a local copy so it opens instantly and
   works offline, queues changes in an outbox, and syncs every 30 seconds. */
(function () {
  "use strict";

  var LS = { session: "rally.session", cache: "rally.cache", outbox: "rally.outbox" };
  var WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var ICON = {
    logo: '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="var(--teal)"/><circle cx="16" cy="11" r="3.2" fill="var(--teal-ink)"/><circle cx="10" cy="19" r="3.2" fill="var(--teal-ink)"/><circle cx="22" cy="19" r="3.2" fill="var(--teal-ink)"/><path d="M16 14.5v3M12.6 18.2l1.9-1M19.4 18.2l-1.9-1" stroke="var(--teal-ink)" stroke-width="1.6" stroke-linecap="round"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>',
    meds: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.5 20.5a5 5 0 0 1-7-7l6-6a5 5 0 0 1 7 7z"/><path d="M8.5 8.5l7 7"/></svg>',
    tasks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/></svg>',
    log: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h12l4 4v12H4z"/><path d="M8 12h8M8 16h5"/></svg>',
    family: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17.5" cy="9" r="2.5"/><path d="M16 14.2a5 5 0 0 1 5.5 4.8"/></svg>',
    tick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
  };

  // ---------- Storage helpers ----------
  function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function keep(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function drop(k) { try { localStorage.removeItem(k); } catch (e) {} }

  var session = load(LS.session);
  var cache = load(LS.cache);
  var outbox = load(LS.outbox) || [];
  if (!session || !cache || !cache.circle || cache.circle.id !== session.circleId) cache = null;

  var tab = "today";
  var online = true;
  var pendingRender = false;
  var lastInvite = null;
  var lastDeviceLink = null;
  var confirmRemove = null;
  var plan = "year";

  // ---------- Small utilities ----------
  function uid() { var a = new Uint8Array(8); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, "0"); }).join(""); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function dayKey(d) { d = d || new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function nowMin() { var d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  function toMin(t) { var p = t.split(":"); return (+p[0]) * 60 + (+p[1]); }
  function fmtTime(t) { var m = typeof t === "number" ? t : toMin(t); var h = Math.floor(m / 60), mm = m % 60; return (h % 12 || 12) + (mm ? ":" + String(mm).padStart(2, "0") : "") + (h >= 12 ? "pm" : "am"); }
  function clock(ts) { var d = new Date(ts); return fmtTime(d.getHours() * 60 + d.getMinutes()); }
  function fmtStamp(ts) {
    var d = new Date(ts), k = dayKey(d), y = new Date(); y.setDate(y.getDate() - 1);
    if (k === dayKey()) return "Today, " + clock(ts);
    if (k === dayKey(y)) return "Yesterday, " + clock(ts);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ", " + clock(ts);
  }
  function money(n) { return "$" + (Math.round(n * 100) / 100).toFixed(2); }

  var toastTimer;
  function toast(msg) {
    var old = document.querySelector(".toast"); if (old) old.remove();
    var el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); el.textContent = msg;
    document.body.appendChild(el); clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.remove(); }, 2600);
  }

  // ---------- API ----------
  function api(path, opts) {
    opts = opts || {};
    var headers = { "Content-Type": "application/json" };
    if (session && session.token) headers.Authorization = "Bearer " + session.token;
    return fetch(path, { method: opts.method || "GET", headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) { var err = new Error(data.error || "Something went wrong."); err.status = res.status; throw err; }
          return data;
        });
      }, function () { var err = new Error("You're offline. Changes will sync when you reconnect."); err.status = 0; throw err; });
  }

  function signOutLocal(message) {
    session = null; cache = null; outbox = [];
    drop(LS.session); drop(LS.cache); drop(LS.outbox);
    tab = "today"; render(); if (message) toast(message);
  }

  // ---------- Local store and sync ----------
  function key(kind, id) { return kind + ":" + id; }
  function saveCache() { keep(LS.cache, cache); keep(LS.outbox, outbox); }

  function put(kind, id, data, deleted) {
    var k = key(kind, id);
    cache.records[k] = { kind: kind, id: id, data: data, deleted: !!deleted, updatedAt: Date.now(), updatedBy: me().id };
    outbox = outbox.filter(function (o) { return key(o.kind, o.id) !== k; });
    outbox.push({ kind: kind, id: id, data: data, deleted: !!deleted });
    saveCache(); render(); flush();
  }

  var flushing = null;
  function flush() {
    if (flushing || !session || !outbox.length) return flushing || Promise.resolve();
    var batch = outbox.slice(0, 200);
    flushing = api("/api/records", { method: "POST", body: { ops: batch } }).then(function () {
      var sent = batch.map(function (o) { return key(o.kind, o.id) + JSON.stringify(o.data) + o.deleted; });
      outbox = outbox.filter(function (o) { return sent.indexOf(key(o.kind, o.id) + JSON.stringify(o.data) + o.deleted) < 0; });
      setOnline(true); saveCache();
    }, function (err) {
      if (err.status === 0) { setOnline(false); return; }
      if (err.status === 401) { signOutLocal(err.message); return; }
      // The server refused these changes: drop them and reload the real state.
      outbox = outbox.filter(function (o) { return batch.indexOf(o) < 0; });
      saveCache(); toast(err.message); return sync(true);
    }).then(function () { flushing = null; if (outbox.length && online) return flush(); }, function () { flushing = null; });
    return flushing;
  }

  function setOnline(v) { if (online !== v) { online = v; renderSoon(); } }

  var syncing = null;
  function sync(full) {
    if (!session) return Promise.resolve();
    if (syncing) return syncing;
    syncing = flush().then(function () {
      var since = full || !cache ? 0 : cache.lastSync || 0;
      return api("/api/state?since=" + since);
    }).then(function (s) {
      setOnline(true);
      if (!cache || s.full) cache = { records: {} };
      cache.circle = s.circle; cache.me = s.me; cache.members = s.members; cache.billingEnabled = s.billingEnabled; cache.lastSync = s.now;
      var pending = {}; outbox.forEach(function (o) { pending[key(o.kind, o.id)] = true; });
      s.records.forEach(function (r) { var k = key(r.kind, r.id); if (!pending[k]) cache.records[k] = r; });
      saveCache(); renderSoon();
    }, function (err) {
      if (err.status === 0) setOnline(false);
      else if (err.status === 401) signOutLocal(err.message);
    }).then(function () { syncing = null; });
    return syncing;
  }

  // Avoid wiping what someone is typing when a background sync lands.
  function renderSoon() {
    var a = document.activeElement;
    if (a && a.closest && a.closest("form") && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT")) { pendingRender = true; return; }
    if (document.querySelector(".sheet")) { pendingRender = true; return; }
    render();
  }

  // ---------- Selectors ----------
  function me() { return (cache && cache.me) || {}; }
  function members() { return (cache && cache.members) || []; }
  function member(id) { var m = members(); for (var i = 0; i < m.length; i++) if (m[i].id === id) return m[i]; return null; }
  function list(kind) {
    var out = []; if (!cache) return out;
    for (var k in cache.records) { var r = cache.records[k]; if (r.kind === kind && !r.deleted) out.push(r); }
    return out;
  }
  function rec(kind, id) { var r = cache && cache.records[key(kind, id)]; return r && !r.deleted ? r : null; }
  function isPlus() { return cache && cache.circle && cache.circle.plan === "plus"; }
  function isOrganizer() { return me().role === "Organizer"; }
  function parent() { return (cache && cache.circle && cache.circle.parentName) || "your loved one"; }

  function pillsLeft(med) {
    var used = list("dose").filter(function (d) { return d.data.medId === med.id && d.data.at > (med.data.countedAt || 0); }).length;
    return Math.max(0, (med.data.left || 0) - used);
  }
  function doses() {
    var today = dayKey(), n = nowMin(), out = [];
    list("med").forEach(function (m) {
      (m.data.times || []).forEach(function (t) {
        var id = today + "|" + m.id + "|" + t, g = rec("dose", id), due = toMin(t), status;
        if (g) status = "done"; else if (n > due + 30) status = "late"; else if (n >= due - 60) status = "due"; else status = "later";
        out.push({ id: id, med: m, time: t, min: due, given: g, status: status });
      });
    });
    return out.sort(function (a, b) { return a.min - b.min || a.med.data.name.localeCompare(b.med.data.name); });
  }

  // ---------- Pieces ----------
  function avatar(m) {
    if (!m) return '<span class="avatar" style="background:var(--surface-2);color:var(--ink-2)" aria-hidden="true">?</span>';
    return '<span class="avatar" style="background:' + esc(m.color) + '" aria-hidden="true">' + esc(m.name.charAt(0).toUpperCase()) + "</span>";
  }
  function header() {
    return '<header class="top"><div class="brand">' + ICON.logo + "<span>Rally</span></div>" +
      '<div class="status' + (online ? "" : " off") + '" role="status"><i></i>' + (online ? (outbox.length ? "Saving…" : "Synced") : "Offline, will sync") + "</div></header>";
  }
  function tabs() {
    var t = [["today", "Today"], ["meds", "Meds"], ["tasks", "Tasks"], ["log", "Log"], ["family", "Family"]];
    return '<nav class="tabs" aria-label="Sections"><div class="inner">' + t.map(function (x) {
      return '<button data-tab="' + x[0] + '"' + (tab === x[0] ? ' aria-current="page"' : "") + ">" + ICON[x[0]] + x[1] + "</button>";
    }).join("") + "</div></nav>";
  }

  function doseRow(x) {
    var pill = x.status === "done" ? '<span class="pill good">Given</span>' : x.status === "late" ? '<span class="pill bad">Missed ' + fmtTime(x.time) + "</span>" : x.status === "due" ? '<span class="pill warn">Due ' + fmtTime(x.time) + "</span>" : '<span class="pill plain">' + fmtTime(x.time) + "</span>";
    var by = x.given ? "Given by " + esc((member(x.given.data.by) || { name: "someone" }).name) + " at " + clock(x.given.data.at) : esc(x.med.data.note || "Not checked off yet");
    return '<div class="item"><button class="check' + (x.given ? " done" : "") + (x.status === "late" ? " late" : "") + '" data-act="dose" data-id="' + esc(x.id) + '" aria-pressed="' + !!x.given + '" aria-label="' + (x.given ? "Undo " : "Mark given: ") + esc(x.med.data.name) + " " + fmtTime(x.time) + '">' + ICON.check + "</button>" +
      '<div class="grow"><div class="title">' + esc(x.med.data.name) + ' <span class="meta">' + esc(x.med.data.dose) + '</span></div><div class="meta">' + by + "</div></div>" + pill + "</div>";
  }
  function taskRow(t) {
    var w = member(t.data.who), done = !!t.data.done;
    return '<div class="item"><button class="check' + (done ? " done" : "") + '" data-act="task" data-id="' + esc(t.id) + '" aria-pressed="' + done + '" aria-label="' + (done ? "Reopen: " : "Done: ") + esc(t.data.text) + '">' + ICON.check + "</button>" +
      '<div class="grow"><div class="title"' + (done ? ' style="text-decoration:line-through;color:var(--ink-2)"' : "") + ">" + esc(t.data.text) + '</div><div class="meta">' +
      (done && t.data.doneBy ? "Done by " + esc((member(t.data.doneBy) || { name: "someone" }).name) : (w ? esc(w.name) : "Anyone") + (t.data.due ? " · due " + (t.data.due === dayKey() ? "today" : esc(t.data.due)) : "")) + "</div></div>" +
      (!t.data.who && !done ? '<button class="btn small ghost" data-act="claim" data-id="' + esc(t.id) + '">I\'ll do it</button>' : "") +
      '<button class="btn small ghost" data-act="deltask" data-id="' + esc(t.id) + '" aria-label="Delete task">✕</button></div>';
  }
  function logRow(l, solo) {
    var w = member(l.data.who);
    return '<div class="item"' + (solo ? ' style="padding:0;border:0"' : "") + ">" + avatar(w) + '<div class="grow"><div class="row" style="gap:8px;flex-wrap:wrap"><span class="title">' + esc(w ? w.name : "Former member") + '</span><span class="meta">' + fmtStamp(l.data.at) + "</span>" + (l.data.tag ? '<span class="pill plain">' + esc(l.data.tag) + "</span>" : "") + "</div><div>" + esc(l.data.text) + "</div></div></div>";
  }

  // ---------- Screens ----------
  function viewToday() {
    var ds = doses(), late = ds.filter(function (d) { return d.status === "late"; }), given = ds.filter(function (d) { return d.given; }).length;
    var shift = rec("shift", String(new Date().getDay())), onShift = shift && member(shift.data.who);
    var open = list("task").filter(function (t) { return !t.data.done; });
    var activity = list("log").map(function (l) { return l.data.at; }).concat(list("dose").map(function (d) { return d.data.at; }));
    var last = activity.length ? Math.max.apply(null, activity) : 0;
    var h = '<div><p class="eyebrow">' + new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) + "</p><h1>Caring for " + esc(parent()) + "</h1>" +
      '<p class="sub">' + given + " of " + ds.length + " doses given today · " + open.length + " open task" + (open.length === 1 ? "" : "s") + "</p></div>";
    if (members().length < 2 && me().role !== "Aide") h += '<div class="banner info"><div><strong>Bring your family in</strong>Rally works best when everyone who helps can see the plan. <button class="linkbtn" data-tab="family">Send an invite</button></div></div>';
    if (late.length) h += '<div class="banner warn" role="alert"><div><strong>' + late.length + " missed dose" + (late.length > 1 ? "s" : "") + "</strong>Check with whoever is with " + esc(parent()) + ", then tap the circle once it's given.</div></div>";
    if (last && Date.now() - last > 24 * 3600e3) h += '<div class="banner warn"><div><strong>Quiet day</strong>Nothing has been logged for ' + esc(parent()) + " in over a day. Has anyone checked in?</div></div>";
    h += '<section class="card"><div class="row">' + avatar(onShift) + '<div class="grow"><p class="eyebrow">On shift today</p><div class="title">' + (onShift ? esc(onShift.name) + (onShift.id === me().id ? " (you)" : "") : "No one yet") + "</div></div>" +
      (onShift ? "" : '<button class="btn small primary" data-act="takeshift">I\'ll take it</button>') + "</div></section>";
    h += '<section class="card"><div class="row"><h2 class="grow">Today\'s meds</h2><span class="meta">' + given + "/" + ds.length + "</span></div>" +
      (ds.length ? '<div class="bar" aria-hidden="true"><span style="width:' + Math.round(given / ds.length * 100) + '%"></span></div><div class="list">' + ds.map(doseRow).join("") + "</div>"
        : '<div class="empty"><p style="margin:0">No meds yet. Add ' + esc(parent()) + "'s schedule and everyone gets the same checklist.</p>" + '<button class="btn primary" data-tab="meds">Add meds</button></div>') + "</section>";
    h += '<section class="card"><div class="row"><h2 class="grow">Open tasks</h2><button class="btn small ghost" data-tab="tasks">See all</button></div><div class="list">' + (open.length ? open.slice(0, 3).map(taskRow).join("") : '<p class="meta" style="margin:0">Nothing open.</p>') + "</div></section>";
    var latest = list("log").sort(function (a, b) { return b.data.at - a.data.at; })[0];
    h += '<section class="card"><div class="row"><h2 class="grow">Latest note</h2><button class="btn small ghost" data-tab="log">' + (latest ? "Log" : "Add a note") + "</button></div>" + (latest ? logRow(latest, true) : '<p class="meta" style="margin:0">No notes yet.</p>') + "</section>";
    return h;
  }

  function viewMeds() {
    var meds = list("med").sort(function (a, b) { return a.data.name.localeCompare(b.data.name); });
    var h = '<div><h1>Meds</h1><p class="sub">The schedule everyone sees. Checking off a dose counts down the pills left.</p></div>';
    if (meds.length) h += '<section class="card"><div class="list">' + meds.map(function (m) {
      var left = pillsLeft(m), perDay = (m.data.times || []).length, days = perDay ? Math.floor(left / perDay) : 0;
      var refill = isPlus() ? (days <= 7 ? '<span class="pill bad">Refill in ' + days + "d</span>" : '<span class="pill plain">' + days + " days left</span>") : '<button class="pill plus" data-act="plus" style="border:0">Refill alerts · Plus</button>';
      return '<div class="item"><div class="grow"><div class="title">' + esc(m.data.name) + ' <span class="meta">' + esc(m.data.dose) + '</span></div><div class="meta">' + (m.data.times || []).map(fmtTime).join(", ") + (m.data.note ? " · " + esc(m.data.note) : "") + " · " + left + " left</div></div>" + refill +
        (me().role !== "Aide" ? '<button class="btn small ghost" data-act="refill" data-id="' + esc(m.id) + '">Refilled</button><button class="btn small ghost" data-act="delmed" data-id="' + esc(m.id) + '" aria-label="Remove ' + esc(m.data.name) + '">✕</button>' : "") + "</div>";
    }).join("") + "</div></section>";
    if (me().role !== "Aide") h += '<form class="card" id="addmed"><h2>Add a med</h2><div class="field"><label for="mn">Name</label><input id="mn" required maxlength="60" placeholder="e.g. Atorvastatin"></div>' +
      '<div class="grid2"><div class="field"><label for="md">Dose</label><input id="md" maxlength="30" placeholder="20 mg"></div><div class="field"><label for="ml">Pills on hand</label><input id="ml" type="number" min="0" max="2000" value="30"></div></div>' +
      '<div class="field"><label>Times</label><div class="chips">' + ["07:00", "08:00", "12:00", "18:00", "21:00"].map(function (t) { return '<button type="button" class="chip" data-time="' + t + '" aria-pressed="' + (t === "08:00") + '">' + fmtTime(t) + "</button>"; }).join("") +
      '</div><div class="row"><label for="mx" class="meta">Other time</label><input id="mx" type="time" style="border:1px solid var(--line);border-radius:10px;min-height:40px;padding:0 8px;background:var(--surface)"></div></div>' +
      '<div class="field"><label for="mo">Instructions</label><input id="mo" maxlength="80" placeholder="With food"></div><button class="btn primary block" type="submit">Add med</button></form>';
    return h;
  }

  function viewTasks() {
    var all = list("task").sort(function (a, b) { return (b.data.createdAt || 0) - (a.data.createdAt || 0); });
    var open = all.filter(function (t) { return !t.data.done; }), done = all.filter(function (t) { return t.data.done; });
    var h = '<div><h1>Tasks</h1><p class="sub">Anyone can add one. Unassigned tasks get an "I\'ll do it" button.</p></div>';
    h += '<form class="card" id="addtask"><div class="field"><label for="tt">New task</label><input id="tt" required maxlength="120" placeholder="e.g. Book the eye exam"></div><div class="grid2"><div class="field"><label for="tw">Who</label><select id="tw"><option value="">Anyone</option>' +
      members().map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.name) + "</option>"; }).join("") + '</select></div><div class="field"><label for="td">Due</label><input id="td" type="date"></div></div><button class="btn primary block" type="submit">Add task</button></form>';
    h += '<section class="card"><h2>Open (' + open.length + ')</h2><div class="list">' + (open.length ? open.map(taskRow).join("") : '<p class="meta" style="margin:0">Nothing open.</p>') + "</div></section>";
    if (done.length) h += '<section class="card"><h2>Done</h2><div class="list">' + done.slice(0, 20).map(taskRow).join("") + "</div></section>";
    return h;
  }

  function viewLog() {
    var items = list("log").sort(function (a, b) { return b.data.at - a.data.at; });
    var h = '<div><h1>Shared log</h1><p class="sub">How ' + esc(parent()) + " is doing, visits, and doctor updates, in one place.</p></div>";
    h += '<form class="card" id="addlog"><div class="field"><label for="lt">Add a note</label><textarea id="lt" required maxlength="1000" placeholder="How was today?"></textarea></div><div class="chips">' +
      ["Good day", "Health", "Appointment", "Mood", "Fall or injury"].map(function (t, i) { return '<button type="button" class="chip" data-tag="' + t + '" aria-pressed="' + (i === 0) + '">' + t + "</button>"; }).join("") +
      '</div><button class="btn primary block" type="submit">Post note</button></form>';
    h += '<section class="card"><div class="row"><h2 class="grow">Recent</h2>' + (isPlus() ? '<button class="btn small ghost" data-act="summary">Visit summary</button>' : '<button class="pill plus" data-act="plus" style="border:0">Visit summary · Plus</button>') + "</div>" +
      '<div class="list timeline">' + (items.length ? items.slice(0, 100).map(function (l) { return logRow(l); }).join("") : '<p class="meta" style="margin:0">No notes yet. The first one helps everyone feel in the loop.</p>') + "</div></section>";
    return h;
  }

  function inviteMessage(link) { return "I set up a shared care page for " + parent() + " on Rally. Tap to join, no account needed: " + link; }
  function viewFamily() {
    var h = '<div><h1>Family</h1><p class="sub">People join from a link. No app download, no password.</p></div>';
    if (me().role !== "Aide") {
      h += '<section class="card"><h2>Invite someone</h2>';
      if (lastInvite) {
        var link = location.origin + "/j/" + lastInvite.code;
        h += '<p class="meta" style="margin:0">' + (lastInvite.role === "Aide" ? "Aide invite: they'll see today's meds, tasks and the log, but not expenses." : "Family invite.") + " Works for 7 days, for as many people as you send it to.</p>" +
          '<div class="invite" id="invmsg">' + esc(inviteMessage(link)) + "</div>" +
          '<div class="grid2">' + (navigator.share ? '<button class="btn primary" data-act="share">Share…</button>' : "") + '<button class="btn ' + (navigator.share ? "ghost" : "primary") + '" data-act="copy">Copy invite</button></div>' +
          '<p class="meta" style="margin:0">Texting it? <a href="sms:?&body=' + encodeURIComponent(inviteMessage(link)) + '">Open in Messages</a></p>';
      } else {
        h += '<p class="meta" style="margin:0">Create a link and send it by text, WhatsApp or email.</p>';
      }
      h += '<div class="grid2"><button class="btn ' + (lastInvite ? "ghost" : "primary") + '" data-act="invite" data-role="Family">Invite family</button><button class="btn ghost" data-act="invite" data-role="Aide">Invite a paid aide</button></div></section>';
    }
    h += '<section class="card"><h2>Care circle</h2><div class="list">' + members().map(function (m) {
      var self = m.id === me().id;
      var controls = "";
      if (isOrganizer() && !self) {
        controls = '<select aria-label="Role for ' + esc(m.name) + '" data-act="role" data-id="' + esc(m.id) + '" style="border:1px solid var(--line);background:var(--surface);border-radius:10px;min-height:36px;padding:0 6px;font-size:14px">' +
          ["Organizer", "Family", "Aide"].map(function (r) { return "<option" + (m.role === r ? " selected" : "") + ">" + r + "</option>"; }).join("") + "</select>" +
          '<button class="btn small ' + (confirmRemove === m.id ? "accent" : "ghost") + '" data-act="remove" data-id="' + esc(m.id) + '">' + (confirmRemove === m.id ? "Tap to confirm" : "Remove") + "</button>";
      }
      return '<div class="item">' + avatar(m) + '<div class="grow"><div class="title">' + esc(m.name) + (self ? " (you)" : "") + '</div><div class="meta">' + esc(m.role) + (m.role === "Aide" ? " · no expenses" : "") + "</div></div>" + controls + "</div>";
    }).join("") + "</div></section>";
    h += '<section class="card"><h2>Weekly shifts</h2><p class="meta" style="margin:0">Who is checking on ' + esc(parent()) + " each day.</p><div class=\"list\">" + [1, 2, 3, 4, 5, 6, 0].map(function (d) {
      var s = rec("shift", String(d));
      return '<div class="item"><div class="grow title">' + WEEK[d] + (d === new Date().getDay() ? ' <span class="pill good">Today</span>' : "") + '</div><select aria-label="Shift for ' + WEEK[d] + '" data-act="shift" data-day="' + d + '" style="border:1px solid var(--line);background:var(--surface);border-radius:10px;min-height:40px;padding:0 8px"><option value="">Open</option>' +
        members().map(function (m) { return '<option value="' + esc(m.id) + '"' + (s && s.data.who === m.id ? " selected" : "") + ">" + esc(m.name) + "</option>"; }).join("") + "</select></div>";
    }).join("") + "</div></section>";
    if (me().role !== "Aide") h += viewExpenses();
    h += viewPlan() + viewSettings();
    return h;
  }

  function viewExpenses() {
    if (!isPlus()) return '<section class="card"><div class="row"><h2 class="grow">Shared expenses</h2><span class="pill plus">Plus</span></div><p class="meta" style="margin:0">Log receipts and Rally works out who owes whom, with a monthly settle-up.</p><button class="btn ghost block" data-act="plus">Unlock expense split</button></section>';
    var fam = members().filter(function (m) { return m.role !== "Aide"; });
    var month = dayKey().slice(0, 7);
    var items = list("expense").filter(function (e) { return dayKey(new Date(e.data.at)).slice(0, 7) === month; }).sort(function (a, b) { return b.data.at - a.data.at; });
    var total = items.reduce(function (a, e) { return a + e.data.amt; }, 0), share = fam.length ? total / fam.length : 0;
    var bal = fam.map(function (m) { var paid = items.filter(function (e) { return e.data.who === m.id; }).reduce(function (a, e) { return a + e.data.amt; }, 0); return { m: m, net: paid - share }; });
    var owes = settle(bal);
    return '<section class="card"><div class="row"><h2 class="grow">Shared expenses, ' + new Date().toLocaleDateString(undefined, { month: "long" }) + '</h2><span class="money">' + money(total) + "</span></div>" +
      '<p class="meta" style="margin:0">Split evenly between ' + fam.length + " family members: " + money(share) + " each.</p>" +
      '<div class="list">' + items.map(function (e) { var w = member(e.data.who); return '<div class="item">' + avatar(w) + '<div class="grow"><div class="title">' + esc(e.data.what) + '</div><div class="meta">Paid by ' + esc(w ? w.name : "former member") + '</div></div><span class="money">' + money(e.data.amt) + '</span><button class="btn small ghost" data-act="delexp" data-id="' + esc(e.id) + '" aria-label="Delete expense">✕</button></div>'; }).join("") + "</div>" +
      '<form id="addexp" class="grid2"><div class="field"><label for="ew">What</label><input id="ew" required maxlength="60" placeholder="Pharmacy"></div><div class="field"><label for="ea">Amount ($)</label><input id="ea" required type="number" min="0.01" max="100000" step="0.01" placeholder="25.00"></div><button class="btn primary" type="submit" style="grid-column:1/-1">Add expense paid by me</button></form>' +
      '<div class="banner info"><div><strong>Settle up</strong>' + (owes.length ? owes.map(function (o) { return esc(o.from.name) + " pays " + esc(o.to.name) + ' <span class="money">' + money(o.amt) + "</span>"; }).join("<br>") : "Everyone is even.") + "</div></div></section>";
  }
  function settle(bal) {
    var d = bal.filter(function (b) { return b.net < -0.005; }).map(function (b) { return { m: b.m, v: -b.net }; });
    var c = bal.filter(function (b) { return b.net > 0.005; }).map(function (b) { return { m: b.m, v: b.net }; });
    var out = [], i = 0, j = 0;
    while (i < d.length && j < c.length) { var a = Math.min(d[i].v, c[j].v); out.push({ from: d[i].m, to: c[j].m, amt: a }); d[i].v -= a; c[j].v -= a; if (d[i].v < 0.005) i++; if (c[j].v < 0.005) j++; }
    return out;
  }

  function viewPlan() {
    var c = cache.circle, h = '<section class="card"><h2>Plan</h2>';
    if (isPlus()) {
      h += '<div class="row"><span class="pill plus">Family Plus</span><span class="meta grow">' + (c.planStatus === "trialing" ? "Free trial" : c.planStatus === "past_due" ? "Payment problem: update your card" : "Active") + (c.planRenewsAt ? " · renews " + new Date(c.planRenewsAt).toLocaleDateString() : "") + "</span></div>";
      if (isOrganizer() && c.hasBilling) h += '<button class="btn ghost block" data-act="portal">Manage subscription and invoices</button>';
    } else {
      h += '<p class="meta" style="margin:0">You are on Free. Helpers are always free; only one person pays for Plus.</p>' + (isOrganizer() ? '<button class="btn accent block" data-act="plus">See Family Plus</button>' : "");
    }
    return h + "</section>";
  }
  function viewSettings() {
    var h = '<section class="card"><h2>Settings</h2>';
    if (isOrganizer()) h += '<form id="rename" class="row" style="align-items:flex-end"><div class="field grow"><label for="pn2">Caring for</label><input id="pn2" maxlength="40" value="' + esc(parent()) + '"></div><button class="btn ghost" type="submit">Save</button></form>';
    h += '<form id="myname" class="row" style="align-items:flex-end"><div class="field grow"><label for="mn2">Your name</label><input id="mn2" maxlength="40" value="' + esc(me().name) + '"></div><button class="btn ghost" type="submit">Save</button></form>';
    if (lastDeviceLink) h += '<div class="invite">Open this on your other phone within 15 minutes:<br><strong>' + esc(location.origin + "/j/" + lastDeviceLink) + "</strong></div>";
    h += '<button class="btn ghost block" data-act="devicelink">Use Rally on another phone</button>';
    h += '<button class="btn ghost block danger" data-act="signout">Sign out of this phone</button></section>';
    return h;
  }

  function viewWelcome(note) {
    return '<header class="top"><div class="brand">' + ICON.logo + "<span>Rally</span></div></header><main>" +
      '<div class="welcome">' + (note ? '<div class="banner warn"><div>' + esc(note) + "</div></div>" : "") + '<div class="hero-mark">' + ICON.logo + "</div>" +
      "<div><h1>Share the care of a parent, without the group-text chaos.</h1>" +
      '<p class="sub" style="margin-top:8px">Meds, tasks and a shared log in one link. Your family joins in two taps. No accounts, no app store.</p></div>' +
      '<form class="card" id="start"><div class="field"><label for="pn">Who are you caring for?</label><input id="pn" required maxlength="40" placeholder="Mom, Dad, Grandpa Joe" autocomplete="off"></div>' +
      '<div class="field"><label for="yn">Your first name</label><input id="yn" required maxlength="40" placeholder="Sarah" autocomplete="given-name"></div>' +
      '<button class="btn primary block" type="submit">Start a care circle</button><p class="meta" style="text-align:center;margin:0">Free for the whole family. Takes about a minute.</p></form>' +
      '<p class="meta" style="text-align:center">Got an invite? Open the link you were sent.</p></div></main>';
  }

  var joinState = null;
  function viewJoin() {
    var j = joinState, h = '<header class="top"><div class="brand">' + ICON.logo + "<span>Rally</span></div></header><main><div class=\"welcome\">";
    if (!j || j.loading) return h + '<div class="center">Opening your invite…</div></div></main>';
    if (j.error) return h + '<div class="card"><h2>That link didn\'t work</h2><p class="meta" style="margin:0">' + esc(j.error) + '</p><a class="btn ghost block" href="/">Go to Rally</a></div></div></main>';
    h += '<div class="hero-mark">' + ICON.logo + "</div>";
    if (j.kind === "device") return h + "<h1>Add this phone to your Rally account</h1><p class=\"sub\">You'll see " + esc(j.parentName) + "'s care circle here too.</p><button class=\"btn primary block\" data-act=\"joinnow\">Add this phone</button></div></main>";
    return h + "<div><h1>" + esc(j.invitedBy) + " invited you to help care for " + esc(j.parentName) + '</h1><p class="sub" style="margin-top:8px">See today\'s meds, check them off, and share updates with the family.' + (j.role === "Aide" ? " You're joining as a care aide." : "") + "</p></div>" +
      '<form class="card" id="joinf"><div class="field"><label for="jn">Your first name</label><input id="jn" required maxlength="40" autocomplete="given-name" placeholder="Mike"></div><button class="btn primary block" type="submit">Join</button></form><p class="demo-note">No password. Rally remembers this phone.</p></div></main>';
  }

  function render() {
    pendingRender = false;
    var app = document.getElementById("app");
    if (joinState) { app.innerHTML = viewJoin(); return; }
    if (!session) { app.innerHTML = viewWelcome(); return; }
    if (!cache) { app.innerHTML = header() + '<main><div class="center">Loading your care circle…</div></main>'; return; }
    var v = tab === "meds" ? viewMeds() : tab === "tasks" ? viewTasks() : tab === "log" ? viewLog() : tab === "family" ? viewFamily() : viewToday();
    var y = window.scrollY;
    app.innerHTML = header() + "<main>" + v + "</main>" + tabs();
    window.scrollTo(0, y);
  }

  // ---------- Sheets ----------
  function sheet(html) { var l = document.getElementById("layer"); l.innerHTML = '<div class="sheet-wrap" data-act="close"><div class="sheet" role="dialog" aria-modal="true">' + html + "</div></div>"; var f = l.querySelector("button, input"); if (f) f.focus(); }
  function closeSheet() { document.getElementById("layer").innerHTML = ""; if (pendingRender) render(); }
  function plusSheet() {
    var f = [["Sibling expense split", "Log receipts, see who owes whom, settle up monthly."], ["Refill countdown", "Warns a week before any med runs out."], ["Doctor-visit summary", "One page of recent notes and the current med list for appointments."], ["Coming next", "Missed-dose texts, a document vault and calendar sync, included as they ship."]];
    var enabled = cache.billingEnabled;
    sheet('<div class="row"><span class="pill plus">Family Plus</span><span class="grow"></span><button class="btn small ghost" data-act="close">Close</button></div><h2 style="font-size:22px">Less worry for whoever keeps it all together</h2><p class="meta" style="margin:0">One plan covers ' + esc(parent()) + "'s whole circle. Everyone else stays free.</p>" +
      '<ul class="feat">' + f.map(function (x) { return "<li>" + ICON.tick + "<div><strong>" + x[0] + '</strong><div class="meta">' + x[1] + "</div></div></li>"; }).join("") + "</ul>" +
      '<div class="price"><button data-plan="year" aria-pressed="' + (plan === "year") + '"><span class="meta">Yearly · save 30%</span><span class="amt">$59</span><span class="meta">$4.92 a month</span></button><button data-plan="month" aria-pressed="' + (plan === "month") + '"><span class="meta">Monthly</span><span class="amt">$6.99</span><span class="meta">Cancel anytime</span></button></div>' +
      (enabled ? '<button class="btn accent block" data-act="checkout">Start 14-day free trial</button><p class="demo-note">Secure checkout by Stripe. Cancel anytime before the trial ends and you won\'t be charged.</p>' : '<button class="btn accent block" disabled>Coming soon</button><p class="demo-note">Payments aren\'t switched on yet.</p>'));
  }
  function summarySheet() {
    var meds = list("med").map(function (m) { return "<li>" + esc(m.data.name + " " + (m.data.dose || "")) + " · " + (m.data.times || []).map(fmtTime).join(", ") + (m.data.note ? " · " + esc(m.data.note) : "") + "</li>"; }).join("");
    var weekAgo = Date.now() - 7 * 24 * 3600e3;
    var notes = list("log").filter(function (l) { return l.data.at > weekAgo; }).sort(function (a, b) { return b.data.at - a.data.at; }).map(function (l) { return "<li><strong>" + fmtStamp(l.data.at) + ":</strong> " + esc(l.data.text) + "</li>"; }).join("");
    var expected = 0, taken = 0;
    for (var i = 0; i < 7; i++) { var d = new Date(); d.setDate(d.getDate() - i); var k = dayKey(d); list("med").forEach(function (m) { (m.data.times || []).forEach(function (t) { if (i === 0 && toMin(t) > nowMin()) return; expected++; if (rec("dose", k + "|" + m.id + "|" + t)) taken++; }); }); }
    var flagged = list("log").filter(function (l) { return l.data.at > weekAgo && (l.data.tag === "Health" || l.data.tag === "Fall or injury" || l.data.tag === "Mood"); });
    sheet('<div class="row"><h2 class="grow" style="font-size:22px">Visit summary for ' + esc(parent()) + '</h2><button class="btn small ghost" data-act="close">Close</button></div><p class="meta" style="margin:0">From the last 7 days of the shared log and med checklist.</p><div class="card" style="box-shadow:none">' +
      "<h3>Current meds</h3><ul style=\"margin:0;padding-left:20px\">" + (meds || "<li>None listed</li>") + "</ul>" +
      "<h3>Doses checked off</h3><p style=\"margin:0\">" + taken + " of " + expected + " scheduled doses" + (expected ? " (" + Math.round(taken / expected * 100) + "%)" : "") + ".</p>" +
      "<h3>Things to mention</h3><ul style=\"margin:0;padding-left:20px\">" + (flagged.length ? flagged.map(function (l) { return "<li>" + esc(l.data.text) + "</li>"; }).join("") : "<li>Nothing flagged as health, mood or injury.</li>") + "</ul>" +
      "<h3>All recent notes</h3><ul style=\"margin:0;padding-left:20px\">" + (notes || "<li>No notes this week.</li>") + "</ul></div>");
  }

  // ---------- Actions ----------
  function copyInvite() {
    var el = document.getElementById("invmsg"); if (!el) return;
    var txt = el.textContent;
    var fallback = function () { var r = document.createRange(); r.selectNodeContents(el); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); toast("Selected. Copy it from here."); };
    try { navigator.clipboard.writeText(txt).then(function () { toast("Invite copied. Paste it into a text."); }, fallback); } catch (e) { fallback(); }
  }
  function goTo(url) { window.location.href = url; }

  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-tab],[data-act],[data-time],[data-tag],[data-plan]");
    if (!t) return;
    if (t.classList.contains("sheet-wrap") && e.target !== t) return;
    if (t.dataset.tab) { tab = t.dataset.tab; confirmRemove = null; render(); window.scrollTo(0, 0); return; }
    if (t.dataset.time) { t.setAttribute("aria-pressed", t.getAttribute("aria-pressed") === "true" ? "false" : "true"); return; }
    if (t.dataset.tag) { t.parentNode.querySelectorAll("[data-tag]").forEach(function (c) { c.setAttribute("aria-pressed", c === t ? "true" : "false"); }); return; }
    if (t.dataset.plan) { plan = t.dataset.plan; plusSheet(); return; }
    var a = t.dataset.act, id = t.dataset.id;
    if (a !== "remove") confirmRemove = null;
    switch (a) {
      case "close": closeSheet(); return;
      case "dose": {
        var existing = rec("dose", id);
        if (existing) { put("dose", id, existing.data, true); toast("Undone"); }
        else { var p = id.split("|"); put("dose", id, { medId: p[1], time: p[2], day: p[0], by: me().id, at: Date.now() }); toast("Marked given"); }
        return;
      }
      case "task": { var tk = rec("task", id); if (!tk) return; var d = Object.assign({}, tk.data, { done: !tk.data.done, doneBy: tk.data.done ? null : me().id, doneAt: tk.data.done ? null : Date.now() }); put("task", id, d); return; }
      case "claim": { var tc = rec("task", id); if (tc) { put("task", id, Object.assign({}, tc.data, { who: me().id })); toast("It's yours. The family can see that."); } return; }
      case "deltask": { var td = rec("task", id); if (td) put("task", id, td.data, true); return; }
      case "takeshift": put("shift", String(new Date().getDay()), { who: me().id }); toast("You're on shift today"); return;
      case "delmed": { var md = rec("med", id); if (md) { put("med", id, md.data, true); toast("Med removed"); } return; }
      case "refill": { var mr = rec("med", id); if (mr) sheetRefill(mr); return; }
      case "delexp": { var ex = rec("expense", id); if (ex) put("expense", id, ex.data, true); return; }
      case "plus": plusSheet(); return;
      case "summary": summarySheet(); return;
      case "copy": copyInvite(); return;
      case "share": { var el = document.getElementById("invmsg"); if (el && navigator.share) navigator.share({ text: el.textContent }).catch(function () {}); return; }
      case "invite":
        t.disabled = true;
        api("/api/invites", { method: "POST", body: { role: t.dataset.role } }).then(function (r) { lastInvite = r; render(); }, function (err) { toast(err.message); t.disabled = false; });
        return;
      case "devicelink":
        api("/api/me/device-link", { method: "POST", body: {} }).then(function (r) { lastDeviceLink = r.code; render(); }, function (err) { toast(err.message); });
        return;
      case "remove":
        if (confirmRemove !== id) { confirmRemove = id; render(); return; }
        confirmRemove = null;
        api("/api/members/" + id, { method: "DELETE" }).then(function () { toast("Removed. Their link no longer works."); return sync(); }, function (err) { toast(err.message); });
        return;
      case "signout":
        api("/api/me/leave", { method: "POST", body: {} }).catch(function () {}).then(function () { signOutLocal("Signed out of this phone."); });
        return;
      case "checkout":
        t.disabled = true; t.textContent = "Opening checkout…";
        api("/api/billing/checkout", { method: "POST", body: { interval: plan } }).then(function (r) { goTo(r.url); }, function (err) { toast(err.message); t.disabled = false; t.textContent = "Start 14-day free trial"; });
        return;
      case "portal":
        api("/api/billing/portal", { method: "POST", body: {} }).then(function (r) { goTo(r.url); }, function (err) { toast(err.message); });
        return;
      case "joinnow": acceptInvite({}); return;
    }
  });

  function sheetRefill(m) {
    sheet('<div class="row"><h2 class="grow" style="font-size:22px">Refilled ' + esc(m.data.name) + '</h2><button class="btn small ghost" data-act="close">Close</button></div>' +
      '<form id="refillf" data-id="' + esc(m.id) + '"><div class="field"><label for="rc">Pills on hand now</label><input id="rc" type="number" min="0" max="2000" required value="' + pillsLeft(m) + '"></div><button class="btn primary block" type="submit" style="margin-top:12px">Save count</button></form>');
  }

  document.addEventListener("change", function (e) {
    var t = e.target;
    if (t.dataset.act === "shift") {
      if (t.value) put("shift", t.dataset.day, { who: t.value });
      else { var s = rec("shift", t.dataset.day); if (s) put("shift", t.dataset.day, s.data, true); }
    }
    if (t.dataset.act === "role") {
      api("/api/members/" + t.dataset.id, { method: "PATCH", body: { role: t.value } }).then(function () { toast("Role updated"); return sync(); }, function (err) { toast(err.message); render(); });
    }
  });

  function acceptInvite(bodyData) {
    var code = joinState.code;
    return api("/api/invites/" + code + "/join", { method: "POST", body: bodyData }).then(function (r) {
      session = { token: r.token, circleId: r.circleId, memberId: r.memberId };
      keep(LS.session, session); cache = null; outbox = []; keep(LS.outbox, outbox); joinState = null;
      history.replaceState(null, "", "/"); tab = "today"; render();
      return sync(true).then(function () { toast("You're in. Welcome to " + parent() + "'s circle."); });
    }, function (err) { toast(err.message); });
  }

  document.addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target;
    var v = function (id) { var el = document.getElementById(id); return el ? el.value.trim() : ""; };
    var btn = f.querySelector('button[type="submit"]');
    switch (f.id) {
      case "start":
        if (btn) btn.disabled = true;
        api("/api/circles", { method: "POST", body: { parentName: v("pn"), yourName: v("yn") } }).then(function (r) {
          session = { token: r.token, circleId: r.circleId, memberId: r.memberId }; keep(LS.session, session);
          tab = "family"; return sync(true).then(function () { toast("Circle created. Invite your family next."); });
        }, function (err) { toast(err.message); if (btn) btn.disabled = false; });
        return;
      case "joinf": if (btn) btn.disabled = true; acceptInvite({ name: v("jn") }).then(function () { if (btn) btn.disabled = false; }); return;
      case "addmed": {
        var times = Array.prototype.map.call(f.querySelectorAll('[data-time][aria-pressed="true"]'), function (b) { return b.dataset.time; });
        if (v("mx")) times.push(v("mx"));
        times = times.filter(function (x, i, arr) { return arr.indexOf(x) === i; }).sort();
        if (!times.length) { toast("Pick at least one time"); return; }
        put("med", uid(), { name: v("mn"), dose: v("md"), times: times, left: parseInt(v("ml"), 10) || 0, countedAt: Date.now(), note: v("mo") });
        toast("Added. It shows on Today for everyone."); return;
      }
      case "addtask": put("task", uid(), { text: v("tt"), who: v("tw"), due: v("td"), done: false, createdAt: Date.now(), createdBy: me().id }); toast("Task added"); return;
      case "addlog": { var tag = f.querySelector('[data-tag][aria-pressed="true"]'); put("log", uid(), { who: me().id, at: Date.now(), text: v("lt"), tag: tag ? tag.dataset.tag : "" }); toast("Posted to the family"); return; }
      case "addexp": { var amt = Math.round(parseFloat(v("ea")) * 100) / 100; if (!(amt > 0)) { toast("Enter an amount"); return; } put("expense", uid(), { who: me().id, amt: amt, what: v("ew"), at: Date.now() }); return; }
      case "refillf": { var m = rec("med", f.dataset.id); if (m) put("med", m.id, Object.assign({}, m.data, { left: parseInt(v("rc"), 10) || 0, countedAt: Date.now() })); closeSheet(); toast("Count saved"); return; }
      case "rename": api("/api/circle", { method: "PATCH", body: { parentName: v("pn2") } }).then(function () { toast("Saved"); return sync(); }, function (err) { toast(err.message); }); return;
      case "myname": api("/api/me", { method: "PATCH", body: { name: v("mn2") } }).then(function () { toast("Saved"); return sync(); }, function (err) { toast(err.message); }); return;
    }
  });
  document.addEventListener("focusout", function () { setTimeout(function () { if (pendingRender) renderSoon(); }, 50); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeSheet(); });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") sync(); });
  window.addEventListener("online", function () { sync(); });

  // ---------- Boot ----------
  var joinMatch = location.pathname.match(/^\/j\/([a-z0-9]{6,16})\/?$/);
  var params = new URLSearchParams(location.search);
  if (params.get("billing")) {
    history.replaceState(null, "", "/");
    tab = "family";
    if (params.get("billing") === "success") { toast("Welcome to Family Plus. It can take a few seconds to show."); setTimeout(function () { sync(); }, 4000); }
  }
  if (joinMatch) {
    joinState = { code: joinMatch[1], loading: true };
    render();
    api("/api/invites/" + joinMatch[1]).then(function (r) {
      if (session && cache && r.kind === "join" && cache.circle && cache.circle.parentName === r.parentName && members().some(function (m) { return m.name === r.invitedBy; })) {
        joinState = null; history.replaceState(null, "", "/"); render(); toast("You're already in this circle."); return;
      }
      joinState = Object.assign({ code: joinMatch[1] }, r); render();
    }, function (err) { joinState = { code: joinMatch[1], error: err.message }; render(); });
  } else {
    render();
    sync(!cache);
  }
  setInterval(function () { if (session && document.visibilityState === "visible") sync(); }, 30000);
  setInterval(function () { if (session && cache) renderSoon(); }, 60000);
  if ("serviceWorker" in navigator) window.addEventListener("load", function () { navigator.serviceWorker.register("/sw.js").catch(function () {}); });
})();
