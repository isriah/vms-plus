// VMS+ (formerly VC Dashboard) — prototype.
// Runs on my.firstinspires.org/VMS pages using the signed-in session.
// Loading and viewing only read from VMS. Five tabs can write: Staffing (assign, remove, move people),
// Roles (targets, open or close applications), Shift times, Notify (assignment emails) and Message (mass email). Each one previews
// its changes and does nothing until they are confirmed.
// Volunteer data stays in memory. Saved in this browser: shift-time settings, which events and tab
// were open, the notify subject and message, and staged assignments as ID numbers only (no names or emails).
(() => {
  'use strict';
  if (window.__vcDash) return;
  window.__vcDash = true;

  const SVC = '/VMS/Services/VolunteerService.asmx/';
  const ALL_DAY = '06:00am - 10:00pm';
  const CONCURRENCY = 4;

  // ---------- VMS access (read-only) ----------

  // VMS limits how fast one browser may call it: past the limit every request is redirected to a "maintenance"
  // page for about two minutes. When that happens, stop sending anything until it has passed.
  let blockedUntil = 0;
  const THROTTLED = 'VMS is limiting requests from this browser for a couple of minutes (it shows a "maintenance" page). '
    + 'Nothing is wrong with your data. Wait two minutes, then press Refresh.';
  // What "Copy diagnostics" reports: how many requests went to each kind of VMS page, and the recent failures.
  // Only page and service names are kept, never the query string, so no names, emails or ID numbers.
  const diag = { since: Date.now(), requests: {}, errors: [], ms: {} };
  const diagKey = (url, method) => {
    const u = String(url);
    const svcName = /VolunteerService\.asmx\/(\w+)/.exec(u);
    if (svcName) return svcName[1];
    const rep = /ReportID=(\d+)/i.exec(u);
    const page = (/\/VMS\/([^?#]+)/i.exec(u) || [, u])[1];
    return (method && method !== 'GET' ? method + ' ' : '') + page + (rep ? ' (report ' + rep[1] + ')' : '');
  };
  const diagError = (key, what) => {
    diag.errors.push({ t: Date.now(), key, what });
    if (diag.errors.length > 20) diag.errors.shift();
  };
  async function vfetch(url, options) {
    const key = diagKey(url, options && options.method);
    if (Date.now() < blockedUntil) throw new Error(THROTTLED);
    diag.requests[key] = (diag.requests[key] || 0) + 1;
    const t0 = Date.now();
    let res;
    try { res = await fetch(url, options); } catch (e) { diagError(key, 'network error: ' + (e.message || e)); throw e; }
    diag.ms[key] = Math.max(diag.ms[key] || 0, Date.now() - t0);
    if (/maintenance/i.test(res.url || '')) {
      blockedUntil = Date.now() + 120000;
      diagError(key, 'VMS maintenance page (rate limit)');
      throw new Error(THROTTLED);
    }
    if (!res.ok) diagError(key, 'HTTP ' + res.status);
    return res;
  }

  // VMS answers one request per session at a time, so on very large events (Championship) requests queue up behind
  // slow ones and its gateway gives up with a 502/503/504. Reads are safe to repeat: after such an error, all further
  // reads go one at a time and the failed one is tried again after a pause.
  let svcLimit = CONCURRENCY, svcActive = 0;
  const svcWaiting = [];
  // A priority request (the details pane someone just opened) waits at the front of the line.
  async function svcSlot(priority) {
    while (svcActive >= svcLimit) await new Promise((r) => (priority ? svcWaiting.unshift(r) : svcWaiting.push(r)));
    svcActive++;
  }
  // After a server error requests go one at a time; once enough succeed in a row, back to full speed.
  let svcOkStreak = 0;
  // Details-pane requests still loading: background work waits for them.
  let paneBusy = 0;
  function svcFree() {
    svcActive--;
    const next = svcWaiting.shift();
    if (next) next();
  }
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const RETRY_WAITS = [2000, 6000, 15000];

  async function svc(method, params, priority) {
    const q = Object.entries(params)
      .map(([k, v]) => k + '=' + encodeURIComponent(typeof v === 'string' ? JSON.stringify(v) : v))
      .join('&');
    let res;
    for (let attempt = 0; ; attempt++) {
      await svcSlot(priority);
      let failed = '';
      try {
        res = await vfetch(SVC + method + '?' + q, {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          credentials: 'same-origin',
        });
        if ([500, 502, 503, 504].includes(res.status)) failed = 'HTTP ' + res.status;
      } catch (e) {
        if (Date.now() < blockedUntil) throw e; // rate limited: retrying would only extend the block
        failed = e.message || 'network error';
      } finally { svcFree(); }
      if (!failed) {
        if (svcLimit < CONCURRENCY && ++svcOkStreak >= 10) { svcLimit = CONCURRENCY; svcOkStreak = 0; }
        break;
      }
      if (attempt >= RETRY_WAITS.length) throw new Error(method + ' failed (' + failed + ')');
      svcLimit = 1; svcOkStreak = 0;
      await pause(RETRY_WAITS[attempt]);
    }
    if (!res.ok) throw new Error(method + ' failed (HTTP ' + res.status + ')');
    let d;
    try {
      d = (await res.json()).d;
    } catch (e) {
      throw new Error('VMS session expired. Sign in again and reload.');
    }
    if (d === '') return [];
    if (typeof d === 'string') {
      try { d = JSON.parse(d); } catch (e) { /* leave as text */ }
    }
    if (d == null || d.Status === 3) throw new Error('VMS session expired. Sign in again and reload.');
    return d;
  }

  async function svcPost(method, body) {
    const res = await vfetch(SVC + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = (await res.json()).d;
    if (d == null || d.Status === 3) throw new Error('VMS session expired. Sign in again and reload.');
    if (d.Status !== 0) throw new Error(d.Message || 'VMS refused the change');
    return d;
  }

  async function postJson(url, body) {
    const res = await vfetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let d;
    try { d = (await res.json()).d; } catch (e) { throw new Error('VMS session expired. Sign in again and reload.'); }
    if (d == null || d === false || d.Status === 3) throw new Error('VMS session expired. Sign in again and reload.');
    if (typeof d === 'object' && 'Status' in d && d.Status !== 0) throw new Error(d.Message || 'VMS refused the change');
    return d;
  }

  async function fetchDoc(url) {
    const res = await vfetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Could not load ' + url + ' (HTTP ' + res.status + ')');
    return { doc: new DOMParser().parseFromString(await res.text(), 'text/html'), url: res.url };
  }

  async function pool(items, limit, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    });
    await Promise.all(workers);
  }

  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const param = (href, name) => {
    const m = new RegExp('[?&]' + name + '=([^&#]*)', 'i').exec(href || '');
    return m ? decodeURIComponent(m[1]) : null;
  };

  async function listEvents() {
    const { doc, url } = await fetchDoc('/VMS/Default.aspx');
    const events = [];
    const seen = new Set();
    doc.querySelectorAll('a[href*="EventDetails.aspx"]').forEach((a) => {
      const id = Number(param(a.getAttribute('href'), 'ID'));
      if (!id || seen.has(id)) return;
      seen.add(id);
      const cells = [...(a.closest('tr') ? a.closest('tr').cells : [])].map(txt);
      const di = cells.findIndex((c) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(c));
      events.push({
        id, vmsId: id,
        name: txt(a),
        date: di >= 0 ? cells[di] : '',
        days: di >= 0 ? Number(cells[di + 1]) || 1 : 1,
        program: di >= 0 ? cells[di + 2] || '' : '',
      });
    });
    // A coordinator with a single event is redirected straight to that event.
    if (!events.length && /EventDetails\.aspx/i.test(url)) {
      const id = Number(param(url, 'ID'));
      if (id) events.push({ id, vmsId: id, name: 'Event ' + id, date: '', days: 1, program: '' });
    }
    events.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0) || a.name.localeCompare(b.name));
    return events;
  }

  // Minimal CSV reader that copes with quoted fields containing commas and line breaks.
  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  // Some facts are only in VMS reports, so those reports' CSV exports are read in the background.
  // Each reader keeps just the columns it needs and discards the rest.
  // VMS keeps one "current report" per signed-in session: opening a report runs it, and Export sends whichever
  // report ran last. Two reports in flight at once can therefore swap data, so they are run strictly one at a time,
  // and each is recognised by columns only it has (`mustHave`, and `mustNot` where another report is a superset).
  let reportQueue = Promise.resolve();
  function reportRows(evId, reportId, mustHave, mustNot) {
    const run = reportQueue.then(() => reportRowsNow(evId, reportId, mustHave, mustNot));
    reportQueue = run.catch(() => {});
    return run;
  }
  async function reportRowsNow(evId, reportId, mustHave, mustNot) {
    const url = '/VMS/Reports/ReportViewer.aspx?EventID=' + evId + '&ReportID=' + reportId + '&Auto=1';
    const { doc } = await fetchDoc(url);
    // A report with nothing in it shows an empty grid and has no CSV to export.
    const grid = doc.getElementById('MainContent_gv');
    if (grid && grid.rows.length <= 1) return [];
    const form = new URLSearchParams();
    doc.querySelectorAll('input[type=hidden]').forEach((i) => form.append(i.name, i.value));
    form.append('ctl00$MainContent$btnExport', 'Export');
    const res = await vfetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
    });
    if (!res.ok || !/csv/i.test(res.headers.get('content-type') || '')) throw new Error('report export failed');
    const rows = parseCsv(await res.text());
    const head = rows.findIndex((r) => mustHave.every((c) => r.includes(c)));
    if (head < 0 || (mustNot || []).some((c) => rows[head].includes(c))) throw new Error('report layout not recognised');
    const cols = rows[head];
    return rows.slice(head + 1).filter((r) => r.length > 1).map((r) => {
      const o = {};
      cols.forEach((c, i) => { o[c] = (r[i] || '').trim(); });
      return o;
    });
  }

  // Report 27, Volunteer Application Status: one row per person and role they applied for.
  // It says who applied for what, with which preference, and whether that application has been assigned.
  const personKey = (email, last, first) => [email, last, first].map((t) => (t || '').toLowerCase().trim()).join('|');
  // Everyone who applied to each event, kept for the Find tab: filled when an event loads, and by the Find tab for
  // events that aren't loaded. Memory only, like all volunteer details.
  const appIndex = new Map();
  async function appReport(evId) {
    const rows = await reportRows(evId, 27, ['Email', 'Date Applied', 'Role', 'Assignment Status']);
    appIndex.set(evId, {
      at: Date.now(),
      rows: rows.map((r) => ({
        pref: r['Preferred First Name'] || '', legal: r['Legal First Name'] || '', last: r['Last Name'] || '',
        email: (r.Email || '').toLowerCase(), city: r.City || '', st: r['State/Province'] || '', age: r.Age || '',
        role: cleanRole(r.Role || ''), status: r['Assignment Status'] || '', ypp: r['FIRST Youth Protection Policy'] || '',
      })),
    });
    return rows;
  }
  // Report 17, Attendance & Event Planning: one row per assigned person, role and day. It also lists people placed in a
  // role without applying for it (the event's own coordinators, for one), whom the application report leaves out.
  const asgIndex = new Map();
  async function asgReport(evId) {
    const rows = await reportRows(evId, 17, ['Email', 'Role', 'Start Time', 'Shadow/Trainee']);
    asgIndex.set(evId, {
      at: Date.now(),
      rows: rows.map((r) => ({
        pref: r['Preferred First Name'] || '', legal: r['Legal First Name'] || '', last: r['Last Name'] || '',
        email: (r.Email || '').toLowerCase(), city: '', st: '', age: '',
        role: cleanRole(r.Role || ''), status: 'Assigned', ypp: r['FIRST Youth Protection Policy'] || '',
      })),
    });
  }
  async function loadApplications(evId) {
    return (await appReport(evId)).map((r) => ({
      email: r.Email.toLowerCase(),
      key: personKey(r.Email, r['Last Name'], r['Legal First Name']),
      role: cleanRole(r.Role || '').toLowerCase(),
      pref: r.Preference || '',
      open: r['Assignment Status'] === 'Applied',
      date: r['Date Applied'] || '',
    }));
  }
  // The earliest date each person applied.
  function appliedDatesFrom(apps) {
    const dates = new Map();
    apps.forEach((r) => {
      const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(r.date);
      if (!m || !r.email) return;
      const when = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])).getTime();
      if (!dates.has(r.email) || when < dates.get(r.email)) dates.set(r.email, when);
    });
    return dates;
  }

  // VMS only gives applicants one role at a time, and most people apply for several roles, so reading every role
  // repeats the same people many times. The application report already says who applied for which role, so only
  // enough roles are read to have every applicant's record once (`coverRoles`); the rest are built from those
  // (`deriveApplicants`). Anything that does not line up exactly is handed back to be read from VMS directly.
  const openRows = (apps, role) => apps.filter((x) => x.open && x.role === role.name.toLowerCase());
  function coverRoles(roles, apps) {
    const rowsFor = new Map(roles.map((r) => [r, openRows(apps, r)]));
    const uncovered = new Set();
    rowsFor.forEach((rows) => rows.forEach((x) => uncovered.add(x.key)));
    const left = new Set(roles), picked = [];
    while (uncovered.size) {
      let best = null, gain = 0;
      left.forEach((r) => {
        const rows = rowsFor.get(r);
        const n = rows.filter((x) => uncovered.has(x.key)).length;
        // New people per person read: a short list of new people beats a long list of mostly known ones.
        if (n && n / rows.length > gain) { best = r; gain = n / rows.length; }
      });
      if (!best) break;
      left.delete(best);
      picked.push(best);
      rowsFor.get(best).forEach((x) => uncovered.delete(x.key));
    }
    return picked;
  }
  // Returns the roles that still have to be read directly.
  function deriveApplicants(roles, cover, apps) {
    const rest = roles.filter((r) => !cover.includes(r));
    const known = new Map(), unclear = new Set();
    let trusted = true;
    cover.forEach((role) => {
      const got = Array.isArray(role.applicants) ? role.applicants : [];
      const seen = new Set();
      got.forEach((v) => {
        const k = personKey(v.Email, v.LastName, v.FirstName);
        seen.add(k);
        if (known.has(k) && known.get(k).PeopleID !== v.PeopleID) unclear.add(k);
        else known.set(k, v);
      });
      // The report must describe every role that was read exactly, or it is not relied on for the others.
      const expect = new Set(openRows(apps, role).map((x) => x.key));
      if (expect.size !== seen.size || [...expect].some((k) => !seen.has(k))) trusted = false;
    });
    if (!trusted) return rest;
    return rest.filter((role) => {
      const rows = openRows(apps, role);
      if (!rows.every((x) => known.has(x.key) && !unclear.has(x.key))) return true;
      role.applicants = rows.map((x) => ({ ...known.get(x.key), Priority: x.pref, InRole: 0 }));
      return false;
    });
  }

  // Report 21, Training and Certifications: one row per assigned person, role and course.
  async function loadTraining(evId) {
    const out = new Map();
    (await reportRows(evId, 21, ['Email', 'Course Name'])).forEach((r) => {
      const email = r.Email.toLowerCase();
      if (!email || !r['Course Name']) return;
      const requiredCol = Object.keys(r).find((k) => /^required/i.test(k));
      if (!out.has(email)) out.set(email, []);
      out.get(email).push({
        role: r.Role || '', course: r['Course Name'], done: !!r['Completion Date'],
        required: /^(req|y|t|1)/i.test(requiredCol ? r[requiredCol] : ''),
        assigned: /^assigned/i.test(r['Assignment Status'] || ''),
      });
    });
    return out;
  }

  // Report 31, Previous Season Volunteers: what each person did at this event last season.
  async function loadLastSeason(evId) {
    const out = new Map();
    (await reportRows(evId, 31, ['Email', 'Roles Assigned'], ['Start Time', 'Emergency Contact'])).forEach((r) => {
      const email = r.Email.toLowerCase();
      if (email && r['Roles Assigned']) out.set(email, r['Roles Assigned']);
    });
    return out;
  }
  const fmtDay = (ts) => { const d = new Date(ts); return (d.getMonth() + 1) + '/' + d.getDate(); };

  // ---------- Multi-day events ----------
  // VMS schedules an event as a row of day positions starting at the schedule's first date. Each shift has a
  // StartingPosition and a PositionsSpanned. A multi-day event is shown here as one column per day, each column
  // behaving like a one-day event; `ev.id` is then "<VMS id>@<position>" and `ev.vmsId` is what VMS is called with.

  const DAY_MS = 86400000;
  const dateOf = (text) => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text || '');
    return m ? new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])) : null;
  };
  const dayGap = (a, b) => Math.round((b - a) / DAY_MS);
  const covers = (a, pos) => a.StartingPosition <= pos && pos < a.StartingPosition + (a.PositionsSpanned || 1);
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // VMS writes an applicant's available days as two-letter codes, e.g. "Fr Sa Su". Empty means not stated.
  const DAY_CODES = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
  const availableDays = (v) => {
    const t = typeof v.DaysAvailable === 'string' ? v.DaysAvailable.toLowerCase() : '';
    const days = (t.match(/[a-z]{2}/g) || []).filter((c) => DAY_CODES.includes(c));
    return days.length ? days : null;
  };
  // Testing aid: VMS event ids listed here are split across every day of their schedule, not just the event's own days.
  const splitAll = () => {
    try { return new Set((JSON.parse(localStorage.getItem('vcDash.splitDays')) || []).map(Number)); } catch (e) { return new Set(); }
  };

  // The first and last date of an event's schedule, read from a role's scheduling page.
  async function loadExtraEmail(x) {
    if (vmsExtraEmail) return;
    try {
      const { doc } = await fetchDoc('/VMS/Roles/RoleScheduling.aspx?ID=' + x.ev.vmsId + '&RoleID=' + x.role.id + (x.role.custom ? '&IsCustom=True' : ''));
      const extra = doc.getElementById('MainContent_hdnUserExtraEmail');
      if (extra && extra.value) vmsExtraEmail = extra.value.trim();
    } catch (e) { /* leave the box empty */ }
  }
  async function loadWindow(ev, role) {
    const { doc } = await fetchDoc('/VMS/Roles/RoleScheduling.aspx?ID=' + ev.id + '&RoleID=' + role.id + (role.custom ? '&IsCustom=True' : ''));
    const code = [...doc.querySelectorAll('script')].map((x) => x.textContent).join('\n');
    const extra = doc.getElementById('MainContent_hdnUserExtraEmail');
    if (extra && extra.value && !vmsExtraEmail) vmsExtraEmail = extra.value.trim();
    const a = /var startDate\s*=\s*moment\('([^']+)'\)/.exec(code), b = /var endDate\s*=\s*moment\('([^']+)'\)/.exec(code);
    const start = a && dateOf(a[1]), end = b && dateOf(b[1]);
    if (!start || !end || end < start) throw new Error('schedule dates not found');
    return { start, end };
  }

  // Turn one loaded event into its columns: itself for a one-day event, one per day otherwise.
  // VMS schedules start before the event itself (usually the day before): those are setup days, shown as their own
  // columns while "Show setup days" is on.
  function splitDays(raw) {
    raw.src = raw;
    const ev = raw.ev, first = dateOf(ev.date), w = raw.sched;
    const all = splitAll().has(ev.id);
    if (!w || !first) return [raw];
    const last = dayGap(w.start, w.end);
    const lead = Math.max(0, Math.min(dayGap(w.start, first), last + 1)); // positions before the first event day
    const days = [];
    if (all) for (let pos = 0; pos <= last; pos++) days.push(pos);
    else {
      if (state.showSetup) for (let pos = 0; pos < lead; pos++) days.push(pos);
      for (let i = 0; i < Math.max(1, ev.days); i++) { const pos = lead + i; if (pos <= last) days.push(pos); }
    }
    if (days.length < 2) return [raw];
    // A one-day event keeps its own id for the event day, so drafts and shift times saved for it still match.
    const single = ev.days <= 1 && !all;
    return days.map((pos) => {
      const date = new Date(w.start.getFullYear(), w.start.getMonth(), w.start.getDate() + pos);
      const setup = pos < lead;
      return {
        ev: { ...ev, id: single && !setup ? ev.id : ev.id + '@' + pos, vmsId: ev.id, days: 1, pos, multi: true, setup, wd: WEEKDAYS[date.getDay()],
          date: (date.getMonth() + 1) + '/' + date.getDate() + '/' + date.getFullYear() },
        roles: raw.roles.map((r) => {
          const everyone = Array.isArray(r.assigned) ? r.assigned : [];
          const shiftsOf = (v) => v.Assignments || [];
          // On this day: anyone with a shift covering it, plus anyone in the role with no shift at all yet.
          const rows = everyone.filter((v) => !shiftsOf(v).length || shiftsOf(v).some((a) => covers(a, pos))).map((v) => {
            const mine = shiftsOf(v).filter((a) => covers(a, pos));
            return { ...v, Assignments: mine, allShifts: shiftsOf(v),
              otherDays: shiftsOf(v).length > mine.length || mine.some((a) => (a.PositionsSpanned || 1) > 1) };
          });
          // In the role on another day only: offered on this day the same way an applicant is.
          const elsewhere = everyone.filter((v) => shiftsOf(v).length && !shiftsOf(v).some((a) => covers(a, pos)))
            .map((v) => ({ ...v, ID: v.PeopleID, Priority: '', otherDay: true }));
          const told = rows.filter((v) => v.Assignments.some((a) => a.IsNotified)).length;
          // Applicants say which days they can come ("Fr Sa Su"); they are only offered on those days.
          const code = DAY_CODES[date.getDay()];
          const canCome = (v) => setup || !availableDays(v) || availableDays(v).includes(code);
          const applying = (Array.isArray(r.applicants) ? r.applicants : []).filter(canCome);
          return { ...r, assigned: rows,
            // Someone in the role on another day is only offered here if this is one of their available days too.
            applicants: [...applying, ...elsewhere.filter(canCome)],
            counts: r.counts ? { ...r.counts, assigned: told, tentative: rows.length - told,
              applicants: r.readFailed ? r.counts.applicants : applying.length } : null };
        }),
        appliedDates: raw.appliedDates, training: raw.training, lastSeason: raw.lastSeason, src: raw,
      };
    });
  }

  // The date VMS expects ("MM/DD/YYYY") for a day position of a multi-day column's event.
  const posDate = (item, pos) => {
    const st = item.src.sched.start;
    const d = new Date(st.getFullYear(), st.getMonth(), st.getDate() + pos);
    return String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') + '/' + d.getFullYear();
  };
  const saveShift = (vmsId, rowId, asgId, from, to, t) => svcPost('SaveAssignment', {
    eventID: vmsId, peopleRoleID: String(rowId), assignmentID: String(asgId), assignmentType: 'Tentative',
    startDate: from, endDate: to, startTime: t ? t.start : '', endTime: t ? t.end : '', duplicateVolunteerIDs: [],
  });
  // What VMS holds right now for one person in one role. Shift ids change with every save, so they are re-read before each change.
  async function liveRow(item, role, peopleId) {
    const rows = await svc('GetAssignedVolunteers', { eventID: item.ev.vmsId, roleID: role.id, isCustom: role.custom, viewType: 'Event', day: 0 });
    return rows.find((v) => v.PeopleID === peopleId) || null;
  }
  // Change one day of a shift. VMS joins all-day shifts on neighbouring days into one shift covering several days,
  // and saving that shift for a single day drops its other days, so those are put back as their own all-day shift.
  // `want` is the new time for the day, or null to take the day away.
  async function carveDay(item, rowId, a, pos, want) {
    const vmsId = item.ev.vmsId;
    const first = a.StartingPosition, last = first + (a.PositionsSpanned || 1) - 1;
    const D = (n) => posDate(item, n);
    if (want) {
      await saveShift(vmsId, rowId, a.ID, D(pos), D(pos), want);
      if (first < pos) await saveShift(vmsId, rowId, 0, D(first), D(pos - 1), null);
      if (last > pos) await saveShift(vmsId, rowId, 0, D(pos + 1), D(last), null);
    } else if (first === last) {
      await svcPost('ChangeScheduleType', { eventID: vmsId, peopleRoleID: String(rowId), assignmentID: String(a.ID), assignType: 'Remove' });
    } else if (first < pos) {
      await saveShift(vmsId, rowId, a.ID, D(first), D(pos - 1), null);
      if (last > pos) await saveShift(vmsId, rowId, 0, D(pos + 1), D(last), null);
    } else {
      await saveShift(vmsId, rowId, a.ID, D(pos + 1), D(last), null);
    }
  }

  const cleanRole = (name) => name.replace(/\s*\((hidden|inactive)\)\s*/gi, ' ').replace(/\s+/g, ' ').trim();

  // A first load reads everything. A refresh after a change passes the previous result as `prev`:
  // the reports are kept, and when `only` is given just those roles' people lists are read again.
  async function loadEvent(ev, tick, prev, only) {
    // Role counts come from the event page in one request.
    const counts = new Map();
    const { doc } = await fetchDoc('/VMS/Events/EventDetails.aspx?ID=' + ev.id);
    doc.querySelectorAll('a[href*="RoleScheduling.aspx"]').forEach((a) => {
      const tr = a.closest('tr');
      if (!tr) return;
      const nums = [...tr.cells].map(txt).filter((c) => /^-?\d+$/.test(c)).map(Number);
      if (nums.length >= 4) {
        counts.set(cleanRole(txt(a)).toLowerCase(), {
          target: nums[0], assigned: nums[1], tentative: nums[2], applicants: nums[3],
          hidden: /\(hidden\)/i.test(txt(a)),
          invite: !!tr.querySelector('a[href*="ExpressInvite"]'),
        });
      }
    });

    const rawRoles = await svc('GetRoles', { eventID: ev.id, roleType: 0 });
    const roles = rawRoles.map((r) => {
      const name = cleanRole(r.Name);
      return {
        id: r.ID, custom: !!r.IsCustom, key: !!r.IsKey, name,
        inactive: /\(inactive\)/i.test(r.Name),
        counts: counts.get(name.toLowerCase()) || null,
        // Roles VMS leaves off the event page (such as Volunteer Coordinator) carry no target or shifts.
        admin: !counts.has(name.toLowerCase()),
        assigned: [], applicants: [],
      };
    });
    let appliedDates = new Map(), training = new Map(), lastSeason = new Map();
    let sched = prev ? prev.sched : null;
    const before = prev ? new Map(prev.roles.map((r) => [r.id + ':' + r.custom, r])) : null;
    // A refresh of named roles reads just those. A first load, or a refresh of everything, takes applicants from the report.
    const whole = !(prev && only);
    let apps = null;
    if (prev) { appliedDates = prev.appliedDates; training = prev.training; lastSeason = prev.lastSeason; }

    // The application report comes first, because it decides which lists are worth reading.
    // It is a nice-to-have: without it every role is read directly.
    const quiet = new Set();
    // Hidden applicants. VMS lets a coordinator hide an applicant from one role or from every role of the event.
    // Someone hidden from the whole event is on every role's Hidden list, so reading two roles' lists finds them.
    // Someone hidden from one role is found because that role's applicant count is lower than the report says (`odd`).
    let eventHidden = prev && prev.eventHidden ? prev.eventHidden : [];
    const odd = new Set();
    let visible = null;
    const hiddenTab = (role) => svc('GetUnassignedVolunteers', { eventID: ev.id, roleID: role.id, tab: 'Hidden', isCustom: role.custom });
    roles.forEach((role) => {
      const old = before && before.get(role.id + ':' + role.custom);
      role.hidden = old && old.hidden ? old.hidden : [];
    });
    if (whole) {
      tick(0, 1);
      try { apps = await loadApplications(ev.id); appliedDates = appliedDatesFrom(apps); } catch (e) { apps = null; }
      tick(1, 0);
      const probes = roles.filter((r) => !r.admin).slice(0, 2);
      let lists = [];
      try { lists = await Promise.all(probes.map(hiddenTab)); } catch (e) { lists = []; }
      if (lists.length === 2 && lists.every(Array.isArray)) {
        const both = new Set(lists[1].map((v) => v.PeopleID));
        eventHidden = lists[0].filter((v) => both.has(v.PeopleID));
        const all = new Set(eventHidden.map((v) => v.PeopleID));
        probes.forEach((r, i) => { r.hidden = lists[i].filter((v) => !all.has(v.PeopleID)); });
      } else eventHidden = [];
      if (apps) {
        const gone = new Set(eventHidden.map((v) => personKey(v.Email, v.LastName, v.FirstName)));
        visible = apps.filter((x) => !gone.has(x.key));
        roles.forEach((role) => {
          if (!role.admin && role.counts && openRows(visible, role).length !== role.counts.applicants) odd.add(role);
        });
      }
      if (!prev && apps) {
        // A role is quiet when nothing suggests anyone is in it: no count on the event page and no application
        // marked as assigned. Quiet roles are still read, but afterwards, in the background.
        const busy = new Set(apps.filter((x) => !x.open).map((x) => x.role));
        roles.forEach((role) => {
          const c = role.counts;
          if (!role.admin && c && c.assigned + c.tentative === 0 && !busy.has(role.name.toLowerCase())) quiet.add(role);
        });
      }
    }

    const jobs = [];
    const needApplicants = [];
    roles.forEach((role) => {
      const old = before && before.get(role.id + ':' + role.custom);
      if (old && only && !only.has(role.name.toLowerCase())) {
        role.assigned = old.assigned; role.applicants = old.applicants; role.unchecked = old.unchecked; role.readFailed = old.readFailed;
        return;
      }
      if (quiet.has(role)) role.unchecked = true;
      else {
        jobs.push(async () => {
          role.assigned = await svc('GetAssignedVolunteers', {
            eventID: ev.id, roleID: role.id, isCustom: role.custom, viewType: 'Event', day: 0,
          });
        });
      }
      // A role the event page shows with no applicants needs no applicant request, unless someone may be hidden there.
      if (role.counts && role.counts.applicants === 0 && !odd.has(role)) return;
      needApplicants.push(role);
    });
    // If VMS still cannot give one role's applicants after retrying, the event loads without them and says so,
    // instead of failing as a whole.
    const direct = (role) => async () => {
      try {
        role.applicants = await svc('GetUnassignedVolunteers', { eventID: ev.id, roleID: role.id, tab: 'Applicants', isCustom: role.custom });
        role.readFailed = false;
      } catch (e) {
        if (Date.now() < blockedUntil || /session expired/i.test(e.message)) throw e;
        role.applicants = []; role.readFailed = true;
      }
    };
    // Roles that may have someone hidden are read directly, together with their Hidden list.
    const oddOnes = needApplicants.filter((r) => odd.has(r)), plain = needApplicants.filter((r) => !odd.has(r));
    const cover = whole && visible ? coverRoles(plain, visible) : plain;
    cover.forEach((role) => jobs.push(direct(role)));
    oddOnes.forEach((role) => {
      jobs.push(direct(role));
      jobs.push(async () => {
        const all = new Set(eventHidden.map((v) => v.PeopleID));
        try { role.hidden = (await hiddenTab(role)).filter((v) => !all.has(v.PeopleID)); } catch (e) { role.hidden = []; }
      });
    });
    if (!prev) {
      // The schedule dates give the day columns: the event's days and the setup days before it.
      const anchor = roles.find((r) => !r.admin) || roles[0];
      if (anchor) {
        jobs.push(async () => { try { sched = await loadWindow(ev, anchor); } catch (e) { sched = null; } });
      }
    }
    tick(0, jobs.length);
    await pool(jobs, CONCURRENCY, async (job) => { await job(); tick(1, 0); });
    if (whole && visible) {
      const more = deriveApplicants(plain, cover, visible).map(direct);
      tick(0, more.length);
      await pool(more, CONCURRENCY, async (job) => { await job(); tick(1, 0); });
    }
    // The training and last-season reports are slow and only add flags, so they follow in the background.
    return { ev, roles, appliedDates, training, lastSeason, sched, eventHidden, apps: whole ? apps : (prev ? prev.apps : null),
      extrasPending: prev ? !!prev.extrasPending : true };
  }

  // ---------- Data model ----------

  // FIRST's training report lists courses for every role a person holds, at any event. Only the required, unfinished
  // courses for roles they hold at this event count here.
  const owedTraining = (e) => (e && e.training ? e.training : []).filter((t) => t.required && !t.done
    && e.assign.some((a) => a.role.toLowerCase() === cleanRole(t.role || '').toLowerCase()));
  function buildPeople(loaded) {
    const people = new Map();
    const get = (v) => {
      let p = people.get(v.PeopleID);
      if (!p) {
        p = {
          id: v.PeopleID,
          first: v.PreferredName || v.FirstName || '',
          last: v.LastName || '',
          email: v.Email || '',
          age: typeof v.Age === 'number' && v.Age > 0 ? v.Age : null,
          cleared: v.MeetsYPPRequirements !== false,
          clearance: v.YPPStatus || '',
          ev: {}, raw: v,
        };
        people.set(v.PeopleID, p);
      }
      return p;
    };
    const slot = (p, evId) => (p.ev[evId] = p.ev[evId] || { assign: [], applied: [], recs: [] });

    loaded.forEach(({ ev, roles }) => {
      roles.forEach((role) => {
        (Array.isArray(role.assigned) ? role.assigned : []).forEach((v) => {
          slot(get(v), ev.id).recs.push({ role: role.name, v });
          slot(get(v), ev.id).assign.push({
            role: role.name, roleId: role.id, custom: role.custom, admin: role.admin,
            shifts: (v.Assignments || []).map((a) => ({
              time: a.ScheduleDisplayTime || '',
              type: a.TypeName || '',
              shadow: a.Type === 3,
              notified: !!a.IsNotified,
            })),
          });
        });
        (Array.isArray(role.applicants) ? role.applicants : []).forEach((v) => {
          slot(get(v), ev.id).recs.push({ role: role.name, v });
          slot(get(v), ev.id).applied.push({ role: role.name, roleId: role.id, pref: v.Priority || '', times: v.InRole || 0, otherDay: !!v.otherDay });
        });
      });
    });

    people.forEach((p) => {
      loaded.forEach(({ ev, appliedDates, training, lastSeason }) => {
        const e = p.ev[ev.id];
        if (!e) return;
        const email = p.email.toLowerCase();
        if (appliedDates && appliedDates.get(email)) e.appliedOn = appliedDates.get(email);
        if (training && training.get(email)) e.training = training.get(email);
        if (lastSeason && lastSeason.get(email)) e.lastSeason = lastSeason.get(email);
      });
      const whens = Object.values(p.ev).map((e) => e.appliedOn).filter(Boolean);
      p.appliedOn = whens.length ? Math.min(...whens) : null;
    });

    people.forEach((p) => {
      const evs = Object.values(p.ev);
      const assigns = evs.flatMap((e) => e.assign);
      const shifts = assigns.flatMap((a) => a.shifts);
      p.assignedAnywhere = assigns.length > 0;
      p.flags = [];
      if (p.age != null && p.age < 18) p.flags.push('minor');
      if (!p.cleared) p.flags.push('clearance');
      if (shifts.some((s) => s.time === ALL_DAY)) p.flags.push('allday');
      if (shifts.some((s) => !s.notified)) p.flags.push('unnotified');
      if (assigns.some((a) => a.shifts.length === 0 && !a.admin)) p.flags.push('noshift');
      if (evs.some((e) => e.assign.filter((a) => !a.admin).length > 1)) p.flags.push('multirole');
      if (p.assignedAnywhere && evs.some((e) => e.assign.length === 0 && e.applied.length > 0)) p.flags.push('partial');
      const sets = evs.map((e) => e.assign.filter((a) => !a.admin).map((a) => a.role).sort().join('|')).filter(Boolean);
      if (new Set(sets).size > 1) p.flags.push('rolediff');
      if (evs.some((e) => owedTraining(e).length)) p.flags.push('training');
      if (consentOf(p) === 'unsigned') p.flags.push('consent');
      if (evs.some((e) => e.lastSeason)) p.flags.push('returning');
    });
    return [...people.values()].sort((a, b) => a.last.localeCompare(b.last) || a.first.localeCompare(b.first));
  }

  const FLAG_LABEL = {
    minor: 'Minor',
    clearance: 'Needs clearance',
    allday: '6am–10pm',
    unnotified: 'Not notified',
    noshift: 'No shift set',
    multirole: 'Multiple roles',
    partial: 'Assigned some days only',
    rolediff: 'Role differs by day',
    training: 'Training incomplete',
    consent: 'Consent not signed',
    returning: 'Here last season',
  };
  const FLAG_TONE = { minor: 'info', clearance: 'bad', allday: 'warn', unnotified: 'warn', noshift: 'warn', multirole: 'info', partial: 'warn', rolediff: 'info', training: 'warn', consent: 'warn', returning: 'ok' };

  // ---------- UI ----------

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .root { --bg:#f6f7f9; --panel:#fff; --ink:#1b2430; --muted:#5d6b7c; --line:#dfe3e9; --accent:#0066b3; --onaccent:#fff; color-scheme: light;
      --ok:#1f7a3d; --okbg:#e3f4e8; --warn:#8a5a00; --warnbg:#fff1d0; --bad:#a3271f; --badbg:#fde4e1; --info:#234e8a; --infobg:#e4edfb;
      position: fixed; inset: 0; z-index: 2147483000; background: var(--bg); color: var(--ink);
      font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; }
    /* Dark colours apply when the theme is set to Dark, or when it is Auto and the computer is in dark mode. */
    .root.dark { --bg:#12161c; --panel:#1b222b; --ink:#e7ecf2; --muted:#9aa7b6; --line:#2c3643; --accent:#5aa9e6;
        --ok:#7fd69a; --okbg:#173524; --warn:#f0c264; --warnbg:#3b2f10; --bad:#ff9d94; --badbg:#44201c; --info:#9cc0f5; --infobg:#1c2c47; --onaccent:#0b1520; color-scheme: dark; }
    @media (prefers-color-scheme: dark) {
      .root:not(.light) { --bg:#12161c; --panel:#1b222b; --ink:#e7ecf2; --muted:#9aa7b6; --line:#2c3643; --accent:#5aa9e6;
        --ok:#7fd69a; --okbg:#173524; --warn:#f0c264; --warnbg:#3b2f10; --bad:#ff9d94; --badbg:#44201c; --info:#9cc0f5; --infobg:#1c2c47; --onaccent:#0b1520; color-scheme: dark; }
    }
    header { background: var(--panel); border-bottom: 1px solid var(--line); padding: 10px 16px; display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; }
    h1 { font-size: 16px; margin: 0; font-weight: 650; }
    .events { display: flex; flex-wrap: wrap; gap: 6px 14px; flex: 1 1 320px; }
    .events label { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; white-space: nowrap; }
    .events:not(.picker) { flex-wrap: nowrap; min-width: 0; overflow: hidden; }
    .events.picker { position: relative; min-width: 0; }
    .events label[hidden], .evnone[hidden] { display: none; }
    .evsearch { width: 100%; box-sizing: border-box; }
    .evclear { margin: 0; white-space: nowrap; align-self: flex-start; }
    .evtools { display: flex; gap: 14px; }
    .events label.past { color: var(--muted, #888); }
    .evclear:disabled { color: var(--muted, #888); cursor: default; text-decoration: none; }
    .evbtn { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .evmenu { position: absolute; top: calc(100% + 4px); left: 0; z-index: 20; display: flex; flex-direction: column; gap: 8px; min-width: 300px; max-height: 60vh; overflow: auto;
      background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; box-shadow: 0 6px 18px rgba(0,0,0,.18); }
    button, select, input[type=search], input[type=time], input[type=text], input[type=email], input[type=number], textarea { font: inherit; color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; }
    button { cursor: pointer; }
    button.primary { background: var(--accent); border-color: var(--accent); color: var(--onaccent); }
    button:disabled { opacity: .5; cursor: default; }
    .tabs { display: flex; gap: 4px; padding: 8px 16px 0; }
    .tabs button { border-radius: 6px 6px 0 0; border-bottom: none; }
    .tabs button.on { background: var(--accent); border-color: var(--accent); color: var(--onaccent); }
    main { flex: 1; overflow: auto; padding: 12px 16px 24px; }
    .stickybar { position: sticky; bottom: -24px; z-index: 4; border-radius: 8px 8px 0 0; box-shadow: 0 -4px 14px rgba(0, 0, 0, 0.12); } /* -24px: flush with the bottom edge, past main's bottom padding */
    .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
    .bar .grow { flex: 1; }
    .muted { color: var(--muted); }
    .mailask { position: absolute; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.35); }
    .mailbox { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; width: min(460px, 92%); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3); }
    .mailbox .sub { margin: 4px 0 12px; }
    .mailopts { display: grid; gap: 6px; margin-bottom: 10px; }
    .mailopts button { display: flex; flex-direction: column; align-items: flex-start; text-align: left; gap: 1px; }
    .mailopts button small { color: var(--muted); font-size: 12px; }
    .mailopts .gacct { display: grid; gap: 4px; margin: -2px 0 6px 12px; font-size: 12px; color: var(--muted); }
    .mailopts .gacct input { font: inherit; font-size: 13px; color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; }
    .mailopts .gacct .bad { color: var(--bad); }
    select.mailsel { max-width: 300px; field-sizing: content; } /* as wide as the choice shown, not the longest one */
    .spin { display: inline-block; width: 10px; height: 10px; margin-right: 6px; vertical-align: -1px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: vcspin 0.8s linear infinite; }
    @keyframes vcspin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spin { animation-duration: 2.4s; } }
    .status { white-space: nowrap; }
    .msg { padding: 10px 12px; border-radius: 6px; margin-bottom: 10px; background: var(--infobg); color: var(--info); }
    .msg.err { background: var(--badbg); color: var(--bad); }
    table { border-collapse: collapse; width: 100%; background: var(--panel); }
    th, td { border: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
    th { position: sticky; top: -12px; background: var(--panel); font-weight: 600; z-index: 1; }
    th small { display: block; font-weight: 400; color: var(--muted); }
    /* People: the volunteer column stays in view while the event columns scroll sideways. */
    table.ptable th:first-child, table.ptable td:first-child { position: sticky; left: -16px; z-index: 2; background: var(--panel); min-width: 200px;
      box-shadow: 1px 0 0 var(--line); }
    table.ptable th:first-child { z-index: 3; }
    table.ptable td { min-width: 150px; }
    .tabs .diagbtn { margin-left: auto; align-self: center; border: none; background: none; }
    tr.group td { background: var(--bg); font-weight: 600; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .num { font-variant-numeric: tabular-nums; font-weight: 600; }
    .sub { color: var(--muted); font-size: 12px; }
    td.short { background: var(--warnbg); }
    td.full { background: var(--okbg); }
    .chip { display: inline-block; font-size: 12px; padding: 1px 7px; border-radius: 10px; margin: 1px 4px 1px 0; white-space: nowrap; }
    .chip.ok { background: var(--okbg); color: var(--ok); }
    .chip.warn { background: var(--warnbg); color: var(--warn); }
    .chip.bad { background: var(--badbg); color: var(--bad); }
    .chip.info { background: var(--infobg); color: var(--info); }
    .line { margin-bottom: 3px; }
    .board { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 14px; align-items: start; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
    .rolelist { padding: 0; overflow: hidden; }
    .rrow { display: flex; justify-content: space-between; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--line); cursor: pointer; }
    .rrow:hover { background: var(--bg); }
    .rrow.on { background: var(--infobg); color: var(--info); font-weight: 600; }
    /* With many events the counts don't fit beside the name: they move to their own line and wrap between events. */
    .rrow { flex-wrap: wrap; row-gap: 2px; }
    .rrow .rname { flex: 1 1 130px; }
    .rrow .cnt { margin-left: auto; max-width: 100%; text-align: right; font-variant-numeric: tabular-nums; }
    .rrow .cnt > span { white-space: nowrap; }
    .hscroll { overflow-x: auto; }
    /* Day buttons wrap onto more lines instead of pushing the flags out of view. */
    .pacts { text-align: right; max-width: 380px; }
    .lo { color: var(--warn); } .hi { color: var(--ok); }
    .days { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
    .chip.plain { background: var(--bg); color: var(--ink); border: 1px solid var(--line); }
    .chip.new { background: var(--infobg); color: var(--info); border: 1px dashed var(--accent); }
    .chip button { border: none; background: none; padding: 0 0 0 4px; color: inherit; }
    .prow { display: grid; grid-template-columns: minmax(180px, 320px) minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--line); }
    @media (max-width: 900px) {
      .prow { grid-template-columns: minmax(0, 1fr) auto; }
      .prow .pflags { grid-column: 1; grid-row: 2; }
    }
    .pname { font-weight: 600; cursor: pointer; }
    details.hc > summary { font-weight: 600; margin: 0; }
    details.hc[open] > summary { margin-bottom: 8px; }
    .hcgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px 28px; align-items: start; }
    .hcgrid h3 { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: var(--muted); }
    table.hct { width: auto; background: none; }
    table.hct th, table.hct td { position: static; border: none; border-bottom: 1px solid var(--line); padding: 3px 12px 3px 0; }
    table.hct td.num { text-align: right; }
    table.hct td:first-child { white-space: nowrap; }
    .hcevs { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
    .hcbig { margin: 4px 0 6px; } .hcbig .num { font-size: 22px; }
    .hcnote { margin-top: 6px; max-width: 520px; }
    .lnk.pname { font-size: inherit; margin: 0; text-align: left; }
    input.findq { flex: 1 1 320px; max-width: 560px; }
    .findstat { margin-bottom: 8px; }
    .frow { display: grid; grid-template-columns: minmax(200px, 340px) minmax(0, 1fr); gap: 4px 14px; padding: 7px 0; border-bottom: 1px solid var(--line); }
    @media (max-width: 760px) { .frow { grid-template-columns: minmax(0, 1fr); } }
    .vcnote { display: inline-block; position: relative; width: 15px; height: 11px; margin: 0 2px 0 7px; border-radius: 3px; background: var(--accent); vertical-align: -1px; cursor: help; }
    .vcnote::after { content: ''; position: absolute; left: 3px; bottom: -4px; border-style: solid; border-width: 4px 4px 0 0; border-color: var(--accent) transparent transparent transparent; }
    input.otheremail { width: 280px; max-width: 100%; margin-left: 4px; }
    .lnk { border: none; background: none; color: var(--accent); padding: 0; margin: 2px 12px 0 0; font-size: 12px; cursor: pointer; }
    .lnk:hover { text-decoration: underline; }
    .lnk.copying { opacity: .6; cursor: progress; }
    .lnk.copied, .lnk.failed { border-radius: 4px; padding: 0 4px; text-decoration: none; animation: vcpop .45s ease-out; }
    .lnk.copied { color: var(--ok); background: var(--okbg); }
    .lnk.failed { color: var(--bad); background: var(--badbg); }
    @keyframes vcpop { 0% { transform: scale(.85); } 55% { transform: scale(1.12); } 100% { transform: scale(1); } }
    .chip.gone { text-decoration: line-through; color: var(--muted); border-style: dashed; }
    .checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 2px 14px; margin: 6px 0 10px; }
    .linkbox { user-select: all; overflow-wrap: anywhere; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
    input.tgt { width: 62px; padding: 2px 6px; font-weight: 600; }
    input.tgt.dirty { border-color: var(--accent); background: var(--infobg); }
    input.tgt.bad { border-color: var(--bad); background: var(--badbg); }
    .chip.plain.click { cursor: pointer; }
    .panel { position: absolute; top: 0; right: 0; bottom: 0; width: min(480px, 100%); z-index: 5; overflow: auto;
      background: var(--panel); border-left: 1px solid var(--line); box-shadow: -4px 0 16px rgba(0,0,0,.18); padding: 14px 16px 28px;
      transition: transform 140ms ease-out, opacity 140ms ease-out; }
    .panel.away { transform: translateX(16px); opacity: 0; }
    .panel.instant { transition: none; }
    @media (prefers-reduced-motion: reduce) { .panel { transition: none; } }
    .panel h2 { margin: 0; font-size: 17px; }
    .panel h3 { margin: 18px 0 6px; font-size: 13px; font-weight: 600; color: var(--muted); border-bottom: 1px solid var(--line); padding-bottom: 3px; }
    .kv { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 3px 10px; margin: 0; }
    .kv dt { color: var(--muted); } .kv dd { margin: 0; overflow-wrap: anywhere; }
    /* Training: the course name wraps, the status stays in its own column. */
    .tlist .trow { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: baseline; padding: 1px 0; }
    .tlist .trow .chip { margin: 0; }
    .tlist .tok { color: var(--ok); }
    .panel .tok { color: var(--ok); } .panel .twarn { color: var(--warn); }
    .panel .arow + .arow { margin-top: 4px; }

    .tlist details.tfold { margin: 0; }
    .vcnote.notejump { cursor: pointer; margin-left: 10px; vertical-align: 1px; }
    .tlist details.tfold > summary { cursor: pointer; color: var(--muted); padding: 1px 0; }
    .tlist details.tfold[open] > summary { margin-bottom: 2px; }
    .tlist details.tfold > .trow { padding-left: 14px; }
    .panel ul { margin: 0; padding-left: 18px; } .panel li { margin-bottom: 3px; }
    /* Fixed columns, so the counts and years line up whatever the role name or year span. */
    details.hist > summary { display: grid; grid-template-columns: 10px minmax(0, 1fr) 8ch 9ch; column-gap: 8px; align-items: baseline; padding: 3px 0; cursor: pointer; list-style: none; }
    details.hmore > summary { grid-template-columns: 10px minmax(0, 1fr); }
    details.hist > summary::-webkit-details-marker { display: none; }
    details.hist > summary::before { content: '▸'; color: var(--muted); width: 10px; flex: none; }
    details.hist[open] > summary::before { content: '▾'; }
    details.hist .hrole { font-weight: 600; }
    details.hist .hmeta { color: var(--muted); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
    details.hist .hcount { text-align: right; }
    details.hist > ul { margin: 2px 0 8px 18px; font-size: 13px; color: var(--muted); }
    details.hmore > details.hist { margin-left: 0; }
    details.support { margin-top: 10px; }
    details.snote > summary { display: grid; grid-template-columns: 11ch minmax(0, 1fr); gap: 8px; padding: 3px 0 3px 18px; cursor: pointer; list-style: none; font-size: 13px; color: var(--muted); }
    details.snote > summary::-webkit-details-marker { display: none; }
    details.snote .sdate { font-variant-numeric: tabular-nums; }
    details.snote .stext { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    details.snote[open] .stext { white-space: normal; display: none; }
    details.snote .sfull { margin: 0 0 8px 18px; padding: 6px 8px; border-left: 2px solid var(--line); font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .prow button { padding: 3px 10px; margin-left: 4px; }
    .field { display: block; margin-bottom: 10px; }
    .field span { display: block; font-weight: 600; margin-bottom: 3px; }
    .field input[type=text], .field textarea { width: 100%; max-width: 720px; }
    h2 { font-size: 15px; margin: 18px 0 8px; }
    section:first-of-type h2 { margin-top: 4px; }
    details { margin: 0 0 8px; }
    summary { cursor: pointer; color: var(--accent); margin-bottom: 6px; }
    table.narrow { width: auto; min-width: 560px; }
    .toast { position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); background: var(--ink); color: var(--bg); padding: 8px 14px; border-radius: 6px; }
    .sp { flex: 1; }
    .inf { color: var(--info); } .bd { color: var(--bad); }
    .rname { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
    .agechip { flex: none; overflow: hidden; box-sizing: border-box; margin: 0; padding: 0 4px; text-align: center; font-size: 11px; font-weight: 600; }
    .agechip.none { visibility: hidden; }
    .agemark { display: inline-block; font-size: 11px; font-weight: 600; border: 1px solid currentColor; border-radius: 8px; padding: 0 5px; margin-left: 4px; line-height: 15px; }
    .seg { padding: 3px 9px; font-size: 12px; border-radius: 0; }
    .seg:first-of-type { border-radius: 6px 0 0 6px; } .seg:last-of-type { border-radius: 0 6px 6px 0; border-left: none; }
    .seg.on { background: var(--accent); border-color: var(--accent); color: var(--onaccent); }
    table.rt { table-layout: fixed; }
    table.rt th, table.rt td { border: none; border-bottom: 1px solid var(--line); padding: 3px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; position: static; }
    table.rt th { vertical-align: bottom; }
    table.rt .d { width: 170px; }
    table.rt tr.openrow td { border-bottom: none; }
    table.rt tr.stagedrow td { background: var(--infobg); }
    .cell { display: flex; align-items: center; gap: 6px; }
    .xbtn { border: none; background: none; padding: 0 2px; color: var(--muted); }
    .xbtn.paneclose { font-size: 24px; line-height: 1; padding: 0 6px; border-radius: 6px; cursor: pointer; }
    .panenav { display: inline-flex; align-items: center; gap: 2px; margin-right: 6px; font-size: 12px; white-space: nowrap; }
    .panenav .xbtn { font-size: 22px; line-height: 1; padding: 0 6px; border-radius: 6px; cursor: pointer; }
    .panenav .xbtn:hover:not(:disabled) { color: var(--ink); background: var(--bg); }
    .panenav .xbtn:disabled { opacity: 0.35; cursor: default; }
    .xbtn.paneclose:hover { color: var(--ink); background: var(--bg); }
    .slots { display: grid; gap: 4px 6px; align-items: center; }
    .slothead { font-weight: 600; padding: 0 8px; }
    .slothead small { display: block; font-weight: 400; color: var(--muted); font-size: 12px; }
    .slotn { color: var(--muted); font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }
    .slot { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; min-height: 26px; display: flex; align-items: center; gap: 6px; padding: 2px 8px; white-space: nowrap; overflow: hidden; color: var(--ink); }
    .slot.new { background: var(--infobg); border: 1px dashed var(--accent); }
    .slot.open { background: none; border-style: dashed; color: var(--muted); font-size: 12px; cursor: pointer; width: 100%; text-align: left; }
    .slot.pick { border: 2px solid var(--accent); background: var(--infobg); color: var(--info); font-size: 12px; font-weight: 600; }
    .daymark { display: inline-flex; align-items: center; gap: 4px; }
    .filltag { display: inline-flex; align-items: center; gap: 6px; background: var(--infobg); color: var(--info); border: 1px solid var(--accent); border-radius: 10px; padding: 1px 4px 1px 9px; font-size: 12px; font-weight: 600; }
    .launch { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147482999; font: 600 14px system-ui, sans-serif;
      background: #0066b3; color: #fff; border-radius: 22px; padding: 10px 16px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
  `;

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && k !== 'list') el[k] = v;
      else el.setAttribute(k, v);
    });
    kids.flat(Infinity).forEach((kid) => {
      if (kid == null || kid === false) return;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    });
    return el;
  }
  const chip = (tone, label, title) => h('span', { class: 'chip ' + tone, title }, label);
  // VMS sends comment dates as "/Date(1292907600000)/"; anything else is shown as it came.
  const noteDate = (d) => {
    const m = /\/Date\((-?\d+)/.exec(String(d || ''));
    return m ? new Date(Number(m[1])).toLocaleDateString() : String(d || '');
  };
  // FIRST's support system (TARDIS) now copies its case notes, emails and chats into a volunteer's coordinator
  // comments. Its entries are posted by "TARDIS-…"; real coordinator notes come from VMS (or the older VIMS / FileMaker).
  const isSupportNote = (r) => /^TARDIS-/i.test(String(r.postedBy || ''));
  const noteText = (rows) => rows.map((r) => (r.postedDate ? noteDate(r.postedDate) + ': ' : '') + r.note.trim()).join('\n\n');
  const usableNotes = (rows) => (Array.isArray(rows) ? rows.filter((r) => r && typeof r.note === 'string' && r.note.trim()) : []);
  const coordinatorNotes = (rows) => usableNotes(rows).filter((r) => !isSupportNote(r));
  // A speech-bubble mark next to someone with coordinator comments; hovering shows them.
  const noteMark = (id) => {
    const rows = vcNotes.get(id);
    if (!rows || !rows.length) return null;
    return h('span', { class: 'vcnote', title: 'Coordinator comments:\n\n' + noteText(rows), role: 'img', 'aria-label': 'Has coordinator comments' });
  };

  // ---------- Recommended minimum ages, from FIRST's volunteer role pages ----------
  // Source: https://www.firstinspires.org/community/volunteers/roles/<slug>, read 11/12/2026.
  // Each entry: [FIRST role title, page slug, ages, where the role is used]. Ages are per program
  // (fll = FIRST LEGO League Challenge, explore = FLL Explore, ftc, frc) or `all`, as [minimum, preferred, note].
  // Championship-only details are left out except for Championship-only roles. FIRST lets the event's VC grant
  // exceptions after review and approval by the local Program Delivery Partner.
  const AGE_RULES = [
    ['Accommodation Coordinator', 'accommodation-coordinator', { all: [21] }],
    ['Assistant Field Manager', 'assistant-field-manager', { fll: [18] }, 'FLL only'],
    ['Assistant Scorekeeper', 'assistant-scorekeeper', { fll: [15] }, 'FLL Challenge only'],
    ['Attendee Registration Assistant', 'attendee-registration-assistant', { all: [18] }, 'Championship only'],
    ['Audio Visual Crew', 'audio-visual-crew', {}, 'FTC and FRC; no age given'],
    ['Ceremony Assistant', 'ceremony-assistant', { explore: [21] }, 'FLL Explore only'],
    ['Concessions', 'concessions', { fll: [18] }, 'FLL Challenge only'],
    ['Conference Coordinator', 'conference-coordinator', { all: [21] }, 'Championship only'],
    ['Conference Room Attendant', 'conference-room-attendant', { all: [15] }, 'Championship only'],
    ['Control System Advisor', 'control-system-advisor', { all: [18] }, 'FTC and FRC'],
    ['Cross-Program Championship Floater', 'cross-program-championship-floater', { all: [18] }, 'Championship only'],
    ['Dean\'s List Interviewer', 'deans-list-interviewers', { ftc: [18] }, 'FTC only'],
    ['Dean\'s List Reviewer', 'deans-list-reviewers', { ftc: [18] }, 'FTC only'],
    ['Emcee', 'emcee', { fll: [15], ftc: [18], frc: [18] }],
    ['Event Manager', 'event-manager', { frc: [18] }, 'FRC districts only'],
    ['Event Photographer', 'event-photographer', { fll: [18], ftc: [13, 18], frc: [13, 18] }],
    ['Field Assembly/Disassembly', 'field-assembly-disassembly', { all: [13, 18] }, 'FTC and FRC'],
    ['Field Manager', 'field-manager', { fll: [21] }, 'FLL only'],
    ['Field Resetter', 'field-resetter', { all: [13] }],
    ['Field Supervisor', 'field-supervisor', { all: [18] }, 'FTC and FRC'],
    ['FIRST Alumni and Individual Giving', 'first-alumni-and-individual-giving', { all: [18] }, 'Championship only'],
    ['FIRST Impact Award Room Monitor', 'first-impact-award-room-monitor', { frc: [15] }, 'FRC Championship only'],
    ['FIRST Technical Advisor', 'first-technical-advisor', { ftc: [18], frc: [18, 21] }, 'FTC and FRC'],
    ['FIRST Technical Advisor Assistant', 'first-technical-advisor-assistant', { all: [18] }, 'FTC and FRC'],
    ['Floater', 'floater', { fll: [13, 0, 'Depends on the role they cover (13 to 18+)'] }, 'FLL only'],
    ['Game Announcer', 'game-announcer', { ftc: [15], frc: [18] }, 'FTC and FRC'],
    ['Head Judge', 'head-judge', { fll: [18] }, 'FLL only'],
    ['Head Referee', 'head-referee', { fll: [18], ftc: [21, 23], frc: [21] }],
    ['Head Reviewer', 'head-reviewer', { explore: [21] }, 'FLL Explore only'],
    ['Information Booth Assistant', 'information-booth-assistant', { all: [18] }, 'Championship only'],
    ['Inspection Manager', 'inspection-manager', { all: [18] }, 'FTC and FRC'],
    ['Judge', 'judge', { fll: [15, 18], ftc: [18, 21], frc: [18, 21] }],
    ['Judge Advisor', 'judge-advisor', { fll: [21], ftc: [23], frc: [23] }],
    ['Judge Advisor Assistant', 'judge-advisor-assistant', { all: [18] }],
    ['Lead Queuer', 'lead-queuer', { fll: [15], ftc: [18], frc: [18] }],
    ['Lead Robot Inspector', 'lead-robot-inspector', { all: [21] }, 'FTC and FRC'],
    ['Load-In/Out Crew', 'load-in-out-crew', { all: [13] }],
    ['Machine Shop Staff', 'machine-shop-staff', { frc: [18] }, 'FRC only'],
    ['Official Scorer', 'official-scorer', { all: [15, 18] }, 'FTC and FRC'],
    ['Pit Administration Supervisor', 'pit-administration-supervisor', { all: [21] }, 'FTC and FRC'],
    ['Pit Administrator', 'pit-administrator', { fll: [18], ftc: [18], frc: [18] }],
    ['Pit Announcer', 'pit-announcer', { frc: [18] }, 'FRC Championship only'],
    ['Pit Runner', 'pit-runner', { all: [13] }],
    ['Planning Committee', 'planning-committee', { frc: [18] }, 'FRC regionals only'],
    ['Practice Field Disassembly', 'practice-field-dissasembly', { frc: [15] }, 'FRC Championship only'],
    ['Practice Field Attendant', 'practice-field-attendant', { ftc: [15] }, 'FTC'],
    ['Practice Table Coordinator', 'practice-table-coordinator', { all: [18] }, 'FLL Championship only'],
    ['Practice Table Manager', 'practice-table-manager', { all: [18] }, 'FLL Championship only'],
    ['Queuer', 'queuer', { explore: [15, 0, '13 with a parent'], fll: [15, 0, '13 with a parent'], ftc: [13, 15], frc: [13, 15] }],
    ['Quiet Room Attendant', 'quiet-room-attendant', { frc: [18] }, 'FRC only'],
    ['Quiet Room Lead Volunteer', 'quiet-room-lead-volunteer', { all: [18] }, 'Championship only'],
    ['Referee', 'referee', { fll: [15, 18, '18 for direct access to the Event Hub; 15 for offline scoring'], ftc: [18], frc: [18] }],
    ['Reviewer', 'reviewer', { explore: [15, 18] }, 'FLL Explore'],
    ['Robot Inspector', 'robot-inspector', { all: [18] }, 'FTC and FRC'],
    ['Safety Attendant', 'safety-attendant', { all: [13] }],
    ['Safety Manager', 'safety-manager', { frc: [18] }, 'FRC only'],
    ['Score Runner', 'score-runner', { fll: [15] }, 'FLL Challenge only'],
    ['Scorekeeper', 'scorekeeper', { fll: [15], ftc: [18], frc: [18] }],
    ['Scoring Event Admin', 'scoring-event-admin', { ftc: [18] }, 'FTC only'],
    ['Scoring League Admin', 'scoring-league-admin', { ftc: [18] }, 'FTC only'],
    ['Special Operations', 'special-operations', { frc: [15] }, 'FRC Championship only'],
    ['Student Ambassador', 'student-ambassador', { all: [13] }, 'FRC, and FTC at Championship'],
    ['Student Ambassador Coordinator', 'student-ambassador-coordinator', { frc: [18] }, 'FRC only'],
    ['Team Activities', 'team-activities', { explore: [15] }, 'FLL Explore and Championship only'],
    ['Team Registration', 'team-registration', { fll: [18] }, 'FLL Challenge only'],
    ['Technical Director', 'technical-director', { ftc: [18, 21] }, 'FTC only'],
    ['Technical Staff', 'technical-staff', { fll: [18] }, 'FLL only'],
    ['Test/Practice Attendant', 'test-practice-attendant', { frc: [13, 0, 'Leads 18+'] }, 'FRC only'],
    ['Time Keeper', 'time-keeper', { fll: [15] }, 'FLL Challenge only'],
    ['Tournament/Event Director', 'tournament-event-director', { all: [21] }],
    ['Volunteer Central', 'volunteer-central', { all: [18] }, 'Championship only'],
    ['Volunteer Check-In', 'volunteer-check-in', { all: [18] }],
    ['Volunteer Coordinator', 'volunteer-coordinator', { all: [21] }],
    ['Volunteer Room Assistant', 'volunteer-room-assistant', { frc: [18] }, 'FRC only'],
    ['Webcast Operator', 'webcast-operator', { frc: [18] }, 'FRC regionals and Championship only'],
  ];
  // VMS role names that differ from FIRST's page titles.
  const AGE_ALIASES = {
    'judging queuer': 'queuer', 'robot game queuer': 'queuer', 'lead robot game queuer': 'lead-queuer', 'lead judging queuer': 'lead-queuer',
    'lead judge': 'head-judge', 'tournament director': 'tournament-event-director', 'event director': 'tournament-event-director',
    'volunteer room assistant and check-in': 'volunteer-check-in', 'load-in/load-out crew': 'load-in-out-crew',
    'a/v crew': 'audio-visual-crew', 'av crew': 'audio-visual-crew', 'team check-in/registration': 'team-registration',
    'deans list interviewer': 'deans-list-interviewers', 'deans list reviewer': 'deans-list-reviewers',
  };
  const ageKey = (name) => (name || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const AGE_BY_NAME = new Map();
  AGE_RULES.forEach((r) => { AGE_BY_NAME.set(ageKey(r[0]), r); AGE_BY_NAME.set(ageKey(r[1].replace(/-/g, ' ')), r); });
  Object.entries(AGE_ALIASES).forEach(([vms, slug]) => AGE_BY_NAME.set(ageKey(vms), AGE_RULES.find((r) => r[1] === slug)));
  const PROGRAM_NAME = { fll: 'FIRST LEGO League Challenge', explore: 'FIRST LEGO League Explore', ftc: 'FIRST Tech Challenge', frc: 'FIRST Robotics Competition' };
  const programOf = (ev) => {
    const t = (ev && ev.program) || '';
    return /explore/i.test(t) ? 'explore' : /lego/i.test(t) ? 'fll' : /tech challenge/i.test(t) ? 'ftc' : /robotics competition/i.test(t) ? 'frc' : '';
  };
  // The age rule for a role at one event, or null when FIRST gives none.
  // `other` means FIRST only lists the role for a different program; its age is still shown as a guide.
  function ageRule(roleName, ev) {
    const r = AGE_BY_NAME.get(ageKey(roleName));
    if (!r) return null;
    const [title, slug, ages, where] = r;
    const prog = programOf(ev);
    let a = (prog && ages[prog]) || ages.all, other = false;
    if (!a) {
      const vals = Object.values(ages);
      const mins = [...new Set(vals.map((v) => v[0]))];
      if (mins.length !== 1) return null;
      a = vals.sort((x, y) => (y[1] || 0) - (x[1] || 0))[0];
      other = true;
    }
    return { title, url: 'https://www.firstinspires.org/community/volunteers/roles/' + slug, min: a[0], pref: a[1] || 0, note: a[2] || '', where: where || '', other, prog };
  }
  const ageText = (rule) => rule.min + '+' + (rule.pref > rule.min ? ' (' + rule.pref + '+ preferred)' : '') + (rule.note ? '. ' + rule.note : '');
  // How a person's age compares with a role's rule: 'under' the minimum, under the 'pref'erred age, or null.
  const ageIssue = (person, rule) => (!person || person.age == null || !rule ? null
    : person.age < rule.min ? 'under' : rule.pref && person.age < rule.pref ? 'pref' : null);
  // The strictest rule among the loaded events that have this role.
  const strictestRule = (roleName, items) => items.map((l) => ageRule(roleName, l.ev)).filter(Boolean)
    .sort((a, b) => b.min - a.min || b.pref - a.pref)[0] || null;

  // ---------- Shift-time settings (per event, with optional per-role times) ----------

  // Where email opens. For Gmail, an optional address picks which signed-in Google account it opens in.
  const MAILERS = [
    ['gmail', 'Gmail', 'Opens in Gmail in your browser'],
    ['outlook', 'Outlook (work or school)', 'Outlook on the web for Microsoft 365 accounts'],
    ['outlookcom', 'Outlook.com (personal)', 'Outlook on the web for Hotmail, Live and Outlook.com'],
    ['default', 'Default email app', 'Desktop Outlook, Apple Mail or whatever your computer uses'],
  ];
  const TIMES_KEY = 'vcDash.shiftTimes.v1';
  const MIN_TIME = '06:00', MAX_TIME = '22:00';
  function readTimes() {
    try { return JSON.parse(localStorage.getItem(TIMES_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveTimes() {
    // Drop blank per-role rows so only times that were actually set are kept.
    const keep = (k, v) => (v && typeof v === 'object' && 'start' in v && !('roles' in v) && !v.start && !v.end ? undefined : v);
    try { localStorage.setItem(TIMES_KEY, JSON.stringify(state.times, keep)); } catch (e) { /* settings just won't persist */ }
  }
  const cfgFor = (evId) => (state.times[evId] = state.times[evId] || { start: '', end: '', roles: {} });
  const validTime = (t) => !!t && !!t.start && !!t.end && t.start < t.end && t.start >= MIN_TIME && t.end <= MAX_TIME;
  function effectiveTime(evId, roleName) {
    const cfg = cfgFor(evId);
    const own = cfg.roles[roleName.toLowerCase()];
    if (validTime(own)) return own;
    return validTime(cfg) ? { start: cfg.start, end: cfg.end } : null;
  }
  // "13:00" -> "01:00pm", the way VMS prints shift times.
  function vmsClock(t) {
    const [hh, mm] = t.split(':').map(Number);
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return String(h12).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + (hh < 12 ? 'am' : 'pm');
  }
  const vmsRange = (t) => vmsClock(t.start) + ' - ' + vmsClock(t.end);
  function vmsDate(d) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(d || '');
    return m ? m[1].padStart(2, '0') + '/' + m[2].padStart(2, '0') + '/' + m[3] : null;
  }

  // Every shift whose time differs from the configured time for its event and role.
  function plannedChanges() {
    const out = [];
    state.loaded.forEach(({ ev, roles }) => {
      if (ev.days > 1 || !vmsDate(ev.date)) return;
      roles.forEach((role) => {
        if (role.admin || role.inactive) return;
        const want = effectiveTime(ev.id, role.name);
        if (!want) return;
        (Array.isArray(role.assigned) ? role.assigned : []).forEach((v) => {
          const all = v.Assignments || [];
          // Shadow shifts and anyone with several shifts in one role are edge cases left to VMS.
          if (all.length > 1 || all.some((a) => a.Type === 3)) return;
          const a = all[0];
          const from = a ? a.ScheduleDisplayTime || '' : '';
          if (from === vmsRange(want)) return;
          out.push({
            key: ev.id + ':' + v.ID + ':' + (a ? a.ID : 0),
            ev, role: role.name, rowId: v.ID, asgId: a ? a.ID : '0', peopleId: v.PeopleID,
            name: (v.PreferredName || v.FirstName || '') + ' ' + (v.LastName || ''),
            from, want, notified: a ? !!a.IsNotified : false,
          });
        });
      });
    });
    return out;
  }

  // ---------- Saved progress (survives reloads) ----------

  const DRAFTS_KEY = 'vcDash.drafts.v1';
  const saved = (() => {
    let d = {};
    try { d = JSON.parse(localStorage.getItem(DRAFTS_KEY)) || {}; } catch (e) { /* start clean */ }
    return {
      staged: Array.isArray(d.staged) ? d.staged.filter((x) => x && x.evId && x.role && x.peopleId) : [],
      notify: d.notify || {},
      selected: Array.isArray(d.selected) ? d.selected : null,
      tab: d.tab, staffRole: d.staffRole, showAssigned: !!d.showAssigned, hideZero: !!d.hideZero, hideLast: !!d.hideLast, staffMode: d.staffMode === 'slot' ? 'slot' : 'person', theme: ['light', 'dark'].includes(d.theme) ? d.theme : 'auto', mailer: /^gmail/.test(d.mailer || '') ? 'gmail' : MAILERS.some(([k]) => k === d.mailer) ? d.mailer : '', gmailAccount: typeof d.gmailAccount === 'string' ? d.gmailAccount : '',
      showNeeded: !!d.showNeeded, showOther: !!d.showOther, showAges: d.showAges !== false, hidePast: d.hidePast !== false, showSetup: d.showSetup !== false,
      reminded: d.reminded && typeof d.reminded === 'object' ? d.reminded : {},
    };
  })();
  function saveDrafts() {
    const data = {
      staged: [...state.staged, ...state.parked].map((x) => ({ evId: x.evId, role: x.role, peopleId: x.peopleId, ...(x.remove ? { remove: true } : {}) })),
      notify: { subject: state.notify.subject, message: state.notify.message, bcc: state.notify.bcc },
      selected: state.events.length ? [...state.selected] : saved.selected,
      tab: state.tab, staffRole: state.staffRole, showAssigned: state.showAssigned, hideZero: state.hideZero, hideLast: state.hideLast, staffMode: state.staffMode, theme: state.theme, mailer: state.mailer, gmailAccount: state.gmailAccount, showNeeded: state.showNeeded, showOther: state.showOther, showAges: state.showAges, hidePast: state.hidePast, showSetup: state.showSetup,
      reminded: state.reminded,
    };
    try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(data)); } catch (e) { /* progress just won't persist */ }
  }

  // After a load, re-check every saved draft against what VMS says now.
  // Drafts for events that are not loaded stay parked until those events are loaded.
  function restoreDrafts() {
    const all = [...state.staged, ...state.parked];
    state.staged = []; state.parked = [];
    let dropped = 0;
    all.forEach((d) => {
      const item = state.loaded.find((l) => l.ev.id === d.evId);
      if (!item) { state.parked.push(d); return; }
      const role = roleIn(item, d.role);
      const person = state.people.find((x) => x.id === d.peopleId);
      const name = person ? person.first + ' ' + person.last : '';
      if (d.remove) {
        // A staged removal only still makes sense if the person is still in that role.
        const row = role && role.assigned.find((v) => v.PeopleID === d.peopleId);
        if (row && person) {
          state.staged.push({ remove: true, evId: d.evId, role: role.name, peopleId: d.peopleId, name,
            notified: (row.Assignments || []).some((a) => a.IsNotified) });
        } else dropped += 1;
        return;
      }
      const ok = role && person && person.ev[d.evId] && person.cleared
        && !realAssign(person, d.evId).some((a) => a.role === role.name)
        && !state.staged.some((x) => !x.remove && x.evId === d.evId && x.peopleId === d.peopleId);
      if (ok) state.staged.push({ evId: d.evId, role: role.name, peopleId: d.peopleId, name });
      else dropped += 1;
    });
    const notes = [];
    if (state.fresh && state.staged.length) notes.push('Restored ' + plural(state.staged.length, 'staged change') + ' from your last session.');
    if (dropped) notes.push(plural(dropped, 'saved draft') + ' no longer fit what is in VMS and ' + (dropped === 1 ? 'was' : 'were') + ' removed.');
    state.restoreNote = notes.join(' ');
    state.fresh = false;
  }

  const state = {
    parked: saved.staged, restoreNote: '', fresh: true,
    times: readTimes(), picks: new Map(), confirming: false, applying: false, applyResult: null,
    events: [], selected: new Set(), loaded: [], people: [],
    tab: ['staff', 'roles', 'people', 'find', 'times', 'notify', 'message'].includes(saved.tab) ? saved.tab : 'staff', busy: false,
    staffRole: saved.staffRole || '', staged: [], showAssigned: saved.showAssigned, poolSearch: '', staffConfirm: false, staffApplying: false, staffResult: null,
    detail: null, hcOpen: false, hcOff: new Set(),
    toggleKey: '', toggling: false, inviteLink: null, hideAsk: null, hiding: false,
    newRole: { open: false, name: '', desc: '', target: '1', allow: true, evs: null, confirming: false, saving: false, error: '', result: null },
    msg: { evs: null, aud: '0', allRoles: true, roles: new Set(), subject: '', message: '', bcc: false, confirming: false, sending: false, error: '', result: null },
    targetEdit: false, targetEdits: new Map(), targetConfirm: false, targetApplying: false, targetResult: null, copyFrom: 0, copyTo: 1,
    notify: { subject: saved.notify.subject || '', message: saved.notify.message || '', bcc: !!saved.notify.bcc, other: false, otherEmail: '', picks: new Map(), confirming: false, sending: false, error: '', result: null }, progress: '', error: '',
    note: '', drafting: false, theme: saved.theme, mailer: saved.mailer, gmailAccount: saved.gmailAccount, mailerAsk: null, staffMode: saved.staffMode, showNeeded: saved.showNeeded, showOther: saved.showOther, fill: null, onlyShort: false, hideZero: saved.hideZero, hideLast: saved.hideLast, showAges: saved.showAges, hidePast: saved.hidePast, showSetup: saved.showSetup, reminded: saved.reminded, sort: 'name', search: '', status: 'all', role: '', toast: '',
  };

  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  let timesDirty = false; // Shift times tab: a time was typed and the tab hasn't been redrawn yet.
  // Coordinator comments on each person's VMS profile (peopleID -> list), read in the background after a load. Memory only.
  const vcNotes = new Map();
  // The extra email address VMS fills into its own Notify form, read from a role page. Memory only.
  let vmsExtraEmail = '';
  shadow.append(h('style', {}, CSS));
  const launch = h('button', { class: 'launch', onclick: open }, 'VMS+');
  const root = h('div', { class: 'root', hidden: true });
  shadow.append(launch, root);
  document.documentElement.append(host);

  async function open() {
    root.hidden = false;
    launch.hidden = true;
    if (!state.events.length) {
      state.busy = true; state.progress = 'Finding your events…'; render();
      try {
        state.events = await listEvents();
        const ids = state.events.map((e) => e.id);
        const remembered = (saved.selected || []).filter((id) => ids.includes(id));
        // Start with nothing ticked, unless events were picked on an earlier visit.
        state.selected = new Set(remembered);
      } catch (e) { state.error = e.message; }
      state.busy = false; state.progress = '';
    }
    render();
  }
  function close() { root.hidden = true; launch.hidden = false; }

  // An event is past once its last day is over. Past events are hidden from the picker unless asked for, and a
  // hidden event is not loaded even if it is still ticked from an earlier visit.
  function isPast(ev) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(ev.date || '');
    if (!m) return false;
    const lastDay = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]) + Math.max(1, ev.days || 1) - 1);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return lastDay < today;
  }
  const shownEvents = () => (state.hidePast ? state.events.filter((ev) => !isPast(ev)) : state.events);

  async function load() {
    const evs = shownEvents().filter((e) => state.selected.has(e.id));
    if (!evs.length) return;
    state.busy = true; state.error = ''; state.loaded = []; state.people = [];
    state.parked = [...state.staged, ...state.parked]; state.staged = [];
    state.staffConfirm = false; state.staffResult = null; state.notify.result = null;
    let done = 0, total = 0;
    const tick = (d, t) => { done += d; total += t; state.progress = 'Loading ' + done + ' of ' + total + ' lists…'; renderHeader(); };
    try {
      const out = [];
      for (const ev of evs) out.push(...splitDays(await loadEvent(ev, tick)));
      state.loaded = out;
      state.people = buildPeople(out);
      restoreDrafts();
    } catch (e) { state.error = e.message; }
    state.busy = false; state.progress = '';
    render();
    background();
  }

  const evLabel = (ev) => (ev.date ? (ev.setup ? 'Setup ' : '') + (ev.wd ? ev.wd + ' ' : '') + ev.date.replace(/\/\d{4}$/, '') + ' · ' : '') + ev.name;
  const roleUrl = (ev, r) => '/VMS/Roles/RoleScheduling.aspx?ID=' + ev.vmsId + '&RoleID=' + r.id + (r.custom ? '&IsCustom=True' : '');

  let headerEl, mainEl, tabsEl;
  const panelEl = h('aside', { class: 'panel', hidden: true });
  const staffLabel = () => 'Staffing' + (state.staged.length ? ' (' + state.staged.length + ' staged)' : '');
  function render() {
    // Redrawing must not move the page: keep the scroll position, except when changing tab.
    const top = mainEl && !state.toTop ? mainEl.scrollTop : 0;
    state.toTop = false;
    root.classList.toggle('dark', state.theme === 'dark');
    root.classList.toggle('light', state.theme === 'light');
    // Someone using a menu or the event search in the header keeps it: replacing it would close the menu.
    const keep = headerBusy();
    [...root.childNodes].forEach((n) => { if (!(keep && n === headerEl)) n.remove(); });
    if (!keep) headerEl = h('header');
    mainEl = h('main');
    const tabs = h('div', { class: 'tabs' },
      [['staff', staffLabel()], ['roles', 'Roles'], ['people', 'People (' + state.people.length + ')'], ['find', 'Find volunteers'],
        ['times', 'Shift times'], ['notify', 'Notify (' + pendingNotifications().length + ')'], ['message', 'Message']].map(([t, label]) => h('button', {
        class: state.tab === t ? 'on' : '',
        onclick: () => { state.tab = t; state.confirming = false; state.staffConfirm = false; state.notify.confirming = false; state.msg.confirming = false; state.toggleKey = ''; state.toTop = true; render(); },
      }, label)),
      h('button', { class: 'lnk diagbtn', title: 'Copy version, load details and recent errors to paste into a bug report. No names or emails.',
        onclick: (e) => copyDiagnostics(e.currentTarget) }, 'Copy diagnostics'));
    tabsEl = tabs;
    if (!keep) root.append(headerEl);
    root.append(tabs, mainEl, panelEl);
    renderPanel();
    if (state.toast) root.append(h('div', { class: 'toast' }, state.toast));
    if (state.mailerAsk) root.append(mailerChooser());
    renderHeader();
    renderMain();
    mainEl.scrollTop = top;
  }

  // True while a header menu is open or the event search is being typed in.
  function headerBusy() {
    const a = shadow.activeElement;
    return !!(headerEl && headerEl.isConnected && a && headerEl.contains(a) && (a.tagName === 'SELECT' || a.classList.contains('evsearch')));
  }
  let headerStale = false;
  function renderHeader() {
    if (!headerEl) return;
    if (headerBusy()) {
      // Only the loading status changes now; the rest is redrawn once they're done with the menu.
      const st = headerEl.querySelector('.status');
      if (st) st.replaceChildren(...(state.progress || state.note ? [h('span', { class: 'spin', 'aria-hidden': 'true' }), state.progress || state.note] : []));
      const go = headerEl.querySelector('button.primary');
      if (go) { go.disabled = state.busy; go.textContent = state.loaded.length ? 'Refresh' : 'Load'; }
      headerEl.querySelectorAll('label[data-ev] input').forEach((b) => { b.disabled = state.busy; });
      headerEl.querySelectorAll('button.evclear').forEach((b) => {
        b.disabled = state.busy || (b.textContent === 'Uncheck all' && !state.selected.size) || (/setup days/.test(b.textContent) && state.staffApplying);
      });
      if (!headerStale) {
        headerStale = true;
        shadow.activeElement.addEventListener('blur', () => { headerStale = false; setTimeout(renderHeader, 0); }, { once: true });
      }
      return;
    }
    headerEl.replaceChildren(
      h('h1', {}, 'VMS+'),
      eventPicker(),
      // While anything is loading, a small spinner sits by the status. Nothing waits on it: the dashboard stays usable.
      h('span', { class: 'muted status' }, state.progress || state.note ? [h('span', { class: 'spin', 'aria-hidden': 'true' }), state.progress || state.note] : ''),
      h('select', { class: 'mailsel', title: 'Where email drafts and email links open',
        onchange: (e) => {
          const v = e.target.value;
          e.target.blur();
          // Choosing Gmail (or changing its account) asks which account, the rest switch straight away.
          if (v === 'gmail' || v === 'gmail-account') { state.mailerAsk = () => {}; render(); return; }
          state.mailer = v; saveDrafts(); render();
        } },
        !state.mailer ? h('option', { value: '', selected: true, disabled: true }, 'Email: choose…') : null,
        MAILERS.map(([k, label]) => h('option', { value: k, selected: state.mailer === k,
          title: (MAILERS.find((m) => m[0] === k) || [])[2] }, 'Email: ' + label + (k === 'gmail' && state.mailer === 'gmail' && state.gmailAccount ? ' (' + state.gmailAccount + ')' : ''))),
        state.mailer === 'gmail' ? h('option', { value: 'gmail-account' }, 'Change Gmail account\u2026') : null),
      h('button', {
        title: 'Auto follows your computer\u2019s light or dark setting. Click to change.',
        onclick: () => { state.theme = { auto: 'dark', dark: 'light', light: 'auto' }[state.theme]; saveDrafts(); render(); },
      }, 'Theme: ' + { auto: 'Auto', dark: 'Dark', light: 'Light' }[state.theme]),
      h('button', { class: 'primary', disabled: state.busy, onclick: load }, state.loaded.length ? 'Refresh' : 'Load'),
      h('button', { onclick: close }, 'Close'),
    );
    // Events that do not fit on one row switch to a dropdown.
    if (!eventsCompact) setTimeout(() => {
      const el = headerEl && headerEl.querySelector('.events');
      if (!eventsCompact && el && el.isConnected && el.scrollWidth > el.clientWidth + 1) { eventsCompact = true; renderHeader(); }
      placePanel();
    }, 0);
  }
  // The details pane starts below the header, so the loading status and the header buttons stay in view.
  function placePanel() {
    if (headerEl && headerEl.isConnected) panelEl.style.top = headerEl.offsetHeight + 'px';
  }

  // Event checkboxes in a row, or in a dropdown when the row would overflow.
  let eventsCompact = false, eventsOpen = false, resizeTimer = 0, eventsQuery = '';
  // The typed phrase as a whole wins ("group 2"); when no event contains it, every word must appear somewhere.
  const evMatches = (ev, q) => {
    if (!q) return true;
    const text = (e) => evLabel(e).toLowerCase();
    if (shownEvents().some((e) => text(e).includes(q))) return text(ev).includes(q);
    return q.split(/\s+/).every((w) => text(ev).includes(w));
  };
  function eventPicker() {
    const q = eventsCompact ? eventsQuery.trim().toLowerCase() : '';
    const list = shownEvents();
    const boxes = list.map((ev) => h('label', { 'data-ev': ev.id, hidden: !evMatches(ev, q), class: isPast(ev) ? 'past' : '' },
      h('input', {
        type: 'checkbox', checked: state.selected.has(ev.id), disabled: state.busy,
        onchange: (e) => { e.target.checked ? state.selected.add(ev.id) : state.selected.delete(ev.id); saveDrafts(); if (eventsCompact) renderHeader(); else clearAll.disabled = state.busy || !state.selected.size; },
      }), evLabel(ev)));
    const clearAll = h('button', { class: 'lnk evclear', disabled: state.busy || !state.selected.size,
      onclick: () => { state.selected.clear(); saveDrafts(); renderHeader(); } }, 'Uncheck all');
    const pastCount = state.events.filter(isPast).length;
    const pastToggle = pastCount ? h('button', { class: 'lnk evclear', disabled: state.busy,
      title: state.hidePast ? 'Show events whose last day is over' : 'Hide events whose last day is over',
      onclick: () => { state.hidePast = !state.hidePast; saveDrafts(); eventsCompact = false; renderHeader(); },
    }, state.hidePast ? 'Show past (' + pastCount + ')' : 'Hide past') : null;
    const setupToggle = h('button', { class: 'lnk evclear', disabled: state.busy || state.staffApplying,
      title: 'Setup days are the days on an event\'s VMS schedule before the event itself (usually the day before)',
      onclick: () => setShowSetup(!state.showSetup) }, state.showSetup ? 'Hide setup days' : 'Show setup days');
    if (!eventsCompact) return h('div', { class: 'events' }, boxes, clearAll, pastToggle, setupToggle);
    const chosen = list.filter((ev) => state.selected.has(ev.id));
    const label = !chosen.length ? 'Choose events'
      : chosen.length === 1 ? evLabel(chosen[0])
        : chosen.length + ' of ' + list.length + ' events: ' + chosen.map(evShort).join(' · ');
    return h('div', { class: 'events picker' },
      h('button', { class: 'evbtn', title: chosen.map(evLabel).join('\n'), onclick: () => {
        eventsOpen = !eventsOpen; eventsQuery = '';
        renderHeader();
        if (eventsOpen) { const s = headerEl.querySelector('.evsearch'); if (s) s.focus(); }
      } }, label + ' ▾'),
      eventsOpen ? h('div', { class: 'evmenu' },
        // Filtering hides rows in place, so typing never loses focus.
        h('input', { class: 'evsearch', type: 'search', placeholder: 'Search events', value: eventsQuery,
          oninput: (e) => {
            eventsQuery = e.target.value;
            const words = eventsQuery.trim().toLowerCase();
            let shown = 0;
            e.target.parentElement.querySelectorAll('label[data-ev]').forEach((l) => {
              const ev = state.events.find((x) => String(x.id) === l.dataset.ev);
              l.hidden = !evMatches(ev, words);
              if (!l.hidden) shown++;
            });
            e.target.parentElement.querySelector('.evnone').hidden = shown > 0;
          } }),
        h('div', { class: 'evtools' }, clearAll, pastToggle, setupToggle),
        boxes,
        h('div', { class: 'sub evnone', hidden: list.some((ev) => evMatches(ev, q)) }, list.length ? 'No events match.' : 'No upcoming events.')) : null);
  }
  // A click anywhere else closes the dropdown; a resize checks again whether the row fits.
  root.addEventListener('click', (e) => {
    if (eventsOpen && !e.composedPath().some((n) => n.classList && n.classList.contains('picker'))) { eventsOpen = false; eventsQuery = ''; renderHeader(); }
  });
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { eventsCompact = false; eventsOpen = false; renderHeader(); }, 200);
  });

  // Show or hide setup-day columns for the events already loaded; nothing needs reading again.
  function setShowSetup(on) {
    state.showSetup = on;
    const raws = [...new Set(state.loaded.map((l) => l.src))];
    state.loaded = raws.flatMap((raw) => splitDays(raw));
    state.people = buildPeople(state.loaded);
    state.fill = null; state.staffConfirm = false;
    restoreDrafts();
    saveDrafts();
    render();
  }

  function renderMain() {
    saveDrafts();
    timesDirty = false;
    if (tabsEl && tabsEl.firstChild) tabsEl.firstChild.textContent = staffLabel();
    const top = mainEl.scrollTop;
    // A box marked with data-fk keeps the keyboard focus across a redraw.
    const was = shadow.activeElement;
    const focusKey = was && mainEl.contains(was) && was.dataset ? was.dataset.fk : '';
    mainEl.replaceChildren();
    if (state.error) mainEl.append(h('div', { class: 'msg err' }, state.error, ' ',
      h('button', { class: 'lnk', onclick: (e) => copyDiagnostics(e.currentTarget) }, 'Copy diagnostics')));
    const failedReads = [];
    new Set(state.loaded.map((l) => l.src)).forEach((raw) => raw.roles.forEach((r) => {
      if (r.readFailed) failedReads.push(r.name + ' (' + evShort(raw.ev) + ')');
    }));
    if (failedReads.length) mainEl.append(h('div', { class: 'msg err' },
      'VMS could not send the applicant list for ' + failedReads.join(', ')
      + ', even after retrying. Those roles show no applicants here; assigned volunteers are complete. Press Refresh to try again.'));
    // Find works across all your events, loaded or not.
    if (!state.loaded.length && state.tab !== 'find') {
      mainEl.append(h('div', { class: 'msg' }, state.busy ? 'Working…'
        : 'Tick the events to view together, then press Load. Loading only reads from VMS. Nothing changes in VMS until you confirm it.'));
      return;
    }
    const views = { staff: staffView, roles: rolesView, people: peopleView, find: findView, times: timesView, notify: notifyView, message: messageView };
    mainEl.append(views[state.tab]());
    mainEl.scrollTop = top;
    if (focusKey) {
      const again = [...mainEl.querySelectorAll('[data-fk]')].find((el) => el.dataset.fk === focusKey);
      if (again && !again.disabled) again.focus({ preventScroll: true });
    }
  }

  // ----- Roles tab -----

  function rolesView() {
    // Targets, invite links and applications belong to the whole VMS event (a role's target is the same on every day),
    // so a multi-day event is one column here, with its counts for the whole event, not one column per day.
    const loaded = [];
    state.loaded.forEach((l) => {
      if (!l.ev.multi) { loaded.push(l); return; }
      if (loaded.some((x) => x.src === l.src)) return;
      const cols = state.loaded.filter((x) => x.src === l.src);
      const evCols = cols.filter((x) => !x.ev.setup), setupCols = cols.filter((x) => x.ev.setup);
      const md = (x) => x.ev.date.replace(/\/\d{4}$/, '');
      const span = [evCols.length > 1 ? evCols.length + ' days, ' + md(evCols[0]) + '–' + md(evCols[evCols.length - 1]) : '',
        setupCols.length ? 'setup ' + setupCols.map(md).join(', ') : ''].filter(Boolean).join(' + ');
      loaded.push({ ev: { ...l.ev, wd: '', setup: false, date: l.src.ev.date, days: Math.max(1, evCols.length), span },
        roles: l.src.roles, src: l.src });
    });
    const names = new Map();
    loaded.forEach(({ roles }, i) => roles.forEach((r) => {
      const k = r.name.toLowerCase();
      if (!names.has(k)) names.set(k, { name: r.name, key: false, per: [] });
      const row = names.get(k);
      row.key = row.key || r.key;
      row.per[i] = r;
    }));
    const count = (r) => {
      const c = r.counts;
      if (r.admin) return { target: null, assigned: r.assigned.length, pending: 0, applicants: r.applicants.length };
      const pendingPeople = r.assigned.filter((v) => !(v.Assignments || []).some((a) => a.IsNotified)).length;
      return {
        target: c ? c.target : null,
        assigned: c ? c.assigned : r.assigned.length - pendingPeople,
        pending: pendingPeople,
        applicants: c ? c.applicants : r.applicants.length,
      };
    };
    let rows = [...names.values()].sort((a, b) => (b.key - a.key) || a.name.localeCompare(b.name));
    const isShort = (row) => row.per.some((r) => { if (!r) return false; const c = count(r); return c.target > 0 && c.assigned < c.target; });
    if (state.onlyShort) rows = rows.filter(isShort);
    // A role with no target is only hidden if nobody is in it or has applied. While editing targets everything stays visible.
    const inUse = (row) => row.per.some((r) => r && (r.admin || (r.counts && (r.counts.target > 0 || r.counts.applicants > 0))
      || r.assigned.length > 0 || r.applicants.some((v) => !v.otherDay)));
    const hiddenCount = state.hideZero && !state.targetEdit ? rows.filter((row) => !inUse(row)).length : 0;
    if (hiddenCount) rows = rows.filter(inUse);

    const totals = loaded.map(({ roles }) => roles.reduce((t, r) => {
      if (r.admin) return t;
      const c = count(r);
      t.target += Math.max(0, c.target || 0); t.assigned += c.assigned; t.pending += c.pending;
      if (c.target > 0 && c.assigned < c.target) t.short += 1;
      return t;
    }, { target: 0, assigned: 0, pending: 0, short: 0 }));

    const firstCol = () => true;
    const daysOf = (i) => (loaded[i].ev.multi ? loaded[i].ev.days : 1);
    const allDays = (i) => (daysOf(i) > 1 ? ' (all ' + daysOf(i) + ' days)' : '');
    const firsts = loaded.map((l, i) => i).filter(firstCol);
    if (!firsts.includes(state.copyFrom)) state.copyFrom = firsts[0] || 0;
    if (!firsts.includes(state.copyTo) || state.copyTo === state.copyFrom) state.copyTo = firsts.find((i) => i !== state.copyFrom) || 0;
    const editing = state.targetEdit;
    const working = state.targetApplying;
    const edits = state.targetEdits;
    const editKey = (ev, r) => ev.id + ':' + r.id + ':' + (r.custom ? 1 : 0);
    const targetKey = (ev, r) => (ev.vmsId || ev.id) + ':' + r.id + ':' + (r.custom ? 1 : 0);
    const nEdits = () => plural(edits.size, 'target change');
    let applyBtn = null;
    const onTarget = (ev, r, from, input) => {
      const raw = input.value.trim();
      const ok = /^\d{1,3}$/.test(raw) && Number(raw) <= 200;
      const key = targetKey(ev, r);
      if (ok && Number(raw) !== from) edits.set(key, { ev, r, from, value: Number(raw) });
      else edits.delete(key);
      input.classList.toggle('bad', !ok);
      input.classList.toggle('dirty', edits.has(key));
      // Update the button in place so typing down a column keeps the cursor where it is.
      if (applyBtn) { applyBtn.textContent = 'Apply ' + nEdits() + '…'; applyBtn.disabled = !edits.size; }
    };
    const copyTargets = () => {
      const a = state.copyFrom, b = state.copyTo;
      if (a === b || !loaded[a] || !loaded[b] || loaded[a].ev.vmsId === loaded[b].ev.vmsId) return;
      names.forEach((row) => {
        const src = row.per[a], dst = row.per[b];
        if (!src || !dst || !src.counts || !dst.counts || src.admin || dst.admin) return;
        const pending = edits.get(targetKey(loaded[a].ev, src));
        const want = pending ? pending.value : src.counts.target;
        if (want !== dst.counts.target) edits.set(targetKey(loaded[b].ev, dst), { ev: loaded[b].ev, r: dst, from: dst.counts.target, value: want });
        else edits.delete(targetKey(loaded[b].ev, dst));
      });
      state.targetConfirm = false; renderMain();
    };

    const cellActions = (ev, r, i) => {
      const key = editKey(ev, r);
      const hidden = r.counts.hidden;
      const span = ''; // the column header already says the event runs several days
      const every = daysOf(i) > 1 ? 'Applies to every day of this event' : '';
      return [
        r.counts.invite ? h('button', { class: 'lnk', title: 'Copy the Express Volunteer sign-up link for this role' + span, onclick: (e) => copyInvite(ev, r, e.currentTarget) }, 'Invite link') : null,
        r.custom ? null : (state.toggleKey === key
          ? [h('button', { class: 'lnk', disabled: state.toggling, onclick: () => toggleApplications(ev, r, hidden) },
              (hidden ? 'Confirm: allow applications' : 'Confirm: stop applications') + span),
            h('button', { class: 'lnk', onclick: () => { state.toggleKey = ''; renderMain(); } }, 'Cancel')]
          : h('button', { class: 'lnk', title: every, onclick: () => { state.toggleKey = key; renderMain(); } },
            (hidden ? 'Allow applications' : 'Stop applications') + span)),
      ];
    };

    const cell = (ev, r, i) => {
      if (!r) return h('td', { class: 'muted' }, '—');
      const c = count(r);
      const cls = c.target > 0 ? (c.assigned < c.target ? 'short' : 'full') : '';
      const bits = [];
      if (c.pending) bits.push(c.pending + ' not notified');
      if (c.applicants) bits.push(c.applicants + ' applicant' + (c.applicants === 1 ? '' : 's'));
      if (r.counts && r.counts.hidden) bits.push('hidden');
      if (r.inactive) bits.push('inactive');
      const pending = edits.get(targetKey(ev, r));
      return h('td', { class: cls },
        editing && c.target != null
          ? [h('span', { class: 'num' }, c.assigned + ' / '),
            h('input', { type: 'number', min: 0, max: 200, step: 1, class: 'tgt' + (pending ? ' dirty' : ''), disabled: working,
              value: pending ? pending.value : c.target,
              title: 'Target for ' + r.name + (daysOf(i) > 1 ? ' on each of the ' + daysOf(i) + ' days' : ''),
              oninput: (e) => onTarget(ev, r, c.target, e.target) })]
          : h('a', { class: 'num', href: roleUrl(ev, r), target: '_blank', title: 'Open this role in VMS' },
            c.target == null ? c.assigned + (c.assigned === 1 ? ' person' : ' people') : c.assigned + ' / ' + c.target),
        bits.length ? h('div', { class: 'sub' }, bits.join(' · ')) : null,
        !editing && !r.admin && r.counts && firstCol(i) ? h('div', {}, cellActions(ev, r, i)) : null);
    };

    const body = [];
    let lastKey = null;
    rows.forEach((row) => {
      if (row.key !== lastKey) {
        lastKey = row.key;
        body.push(h('tr', { class: 'group' }, h('td', { colSpan: loaded.length + 1 }, row.key ? 'Key roles' : 'Other roles')));
      }
      body.push(h('tr', {}, h('td', {}, row.name), loaded.map(({ ev }, i) => cell(ev, row.per[i], i))));
    });

    return h('div', {},
      h('div', { class: 'bar' },
        h('label', {}, h('input', {
          type: 'checkbox', checked: state.onlyShort,
          onchange: (e) => { state.onlyShort = e.target.checked; renderMain(); },
        }), ' Only roles short of target'),
        h('label', {}, h('input', {
          type: 'checkbox', checked: state.hideZero,
          onchange: (e) => { state.hideZero = e.target.checked; renderMain(); },
        }), ' Hide roles with no target' + (hiddenCount ? ' (' + hiddenCount + ' hidden)' : '')),
        h('span', { class: 'muted grow' }, editing ? 'Type new targets, then apply. Nothing changes in VMS until you confirm.' : 'Each cell is assigned and notified / target.'),
        !editing
          ? [h('button', { onclick: () => { state.newRole.open = !state.newRole.open; state.newRole.confirming = false; state.newRole.error = ''; renderMain(); } },
              state.newRole.open ? 'Close add role' : 'Add role'),
            h('button', { onclick: () => { state.targetEdit = true; state.targetResult = null; state.newRole.open = false; renderMain(); } }, 'Edit targets')]
          : [
            loaded.filter((l, i) => firstCol(i)).length > 1 ? [
              'Copy targets from ',
              h('select', { disabled: working, onchange: (e) => { state.copyFrom = Number(e.target.value); } },
                loaded.map(({ ev }, i) => (firstCol(i) ? h('option', { value: i, selected: state.copyFrom === i }, evShort(ev) + allDays(i)) : null))),
              ' to ',
              h('select', { disabled: working, onchange: (e) => { state.copyTo = Number(e.target.value); } },
                loaded.map(({ ev }, i) => (firstCol(i) ? h('option', { value: i, selected: state.copyTo === i }, evShort(ev) + allDays(i)) : null))),
              h('button', { disabled: working, onclick: copyTargets }, 'Copy'),
            ] : null,
            state.targetConfirm
              ? [h('strong', {}, 'Apply ' + nEdits() + ' to VMS?'),
                h('button', { class: 'primary', disabled: working, onclick: applyTargets }, working ? 'Applying…' : 'Yes, apply'),
                h('button', { disabled: working, onclick: () => { state.targetConfirm = false; renderMain(); } }, 'Back')]
              : [(applyBtn = h('button', { class: 'primary', disabled: !edits.size, onclick: () => { state.targetConfirm = true; renderMain(); } }, 'Apply ' + nEdits() + '…')),
                h('button', { onclick: () => { edits.clear(); state.targetEdit = false; state.targetConfirm = false; renderMain(); } }, edits.size ? 'Discard and close' : 'Done')],
          ]),
      resultBox(state.targetResult, (ok) => plural(ok, 'target') + ' updated in VMS.', ''),
      resultBox(state.newRole.result, (ok) => 'Role added to ' + plural(ok, 'event') + '.', ''),
      addRoleForm(),
      state.inviteLink ? h('div', { class: 'msg' + (state.inviteLink.error ? ' err' : '') },
        h('strong', {}, state.inviteLink.label), state.inviteLink.error ? ': ' + state.inviteLink.error : (state.inviteLink.copied ? ' (copied)' : ' (copy it from here)'),
        state.inviteLink.url ? h('div', { class: 'linkbox' }, state.inviteLink.url) : null,
        h('button', { class: 'lnk', onclick: () => { state.inviteLink = null; renderMain(); } }, 'Dismiss')) : null,
      headcountCard(),
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Role'),
          loaded.map(({ ev }, i) => h('th', {}, evLabel(ev),
            ev.span ? h('small', {}, ev.span + ' · counts for the whole event') : null,
            h('small', {}, totals[i].assigned + ' / ' + totals[i].target + ' filled · ' + totals[i].short + ' roles short'
              + (totals[i].pending ? ' · ' + totals[i].pending + ' not notified' : '')),
            h('div', {},
              h('button', { class: 'lnk', title: allDays(i) ? 'One link for every day of this event' : '', onclick: (e) => copyInvite(ev, null, e.currentTarget) }, 'Event invite link'),
              h('button', { class: 'lnk', title: 'Copy the QR code image and open VMS\'s QR code page', onclick: (e) => copyQr(ev, e.currentTarget) }, 'QR code')))))),
        h('tbody', {}, body)));
  }

  // ----- Headcount (Roles tab): people on site each day, for food; different people across events, for shirts -----

  // Each calendar day across the loaded events: who is assigned that day (once each, whatever their roles or events),
  // and the day's goal, which is the role targets of the events running that day added up.
  function dailyHeadcount() {
    const days = new Map();
    const dayAt = (d) => {
      const key = d.getTime();
      if (!days.has(key)) days.set(key, { d, people: new Set(), goal: 0, events: [], setups: [] });
      return days.get(key);
    };
    [...new Set(state.loaded.map((l) => l.src))].forEach((raw) => {
      const ev = raw.ev, w = raw.sched, first = dateOf(ev.date);
      if (!first && !w) return;
      const base = w ? w.start : first;
      const last = w ? dayGap(w.start, w.end) : 0;
      const lead = w && first ? Math.max(0, Math.min(dayGap(w.start, first), last + 1)) : 0;
      const at = (pos) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + pos);
      const eventDays = [];
      for (let i = 0; i < Math.max(1, ev.days || 1); i++) eventDays.push(lead + i);
      const goal = raw.roles.reduce((t, r) => t + (!r.admin && !r.inactive && r.counts ? Math.max(0, r.counts.target || 0) : 0), 0);
      eventDays.forEach((pos) => { const x = dayAt(at(pos)); x.goal += goal; x.events.push(ev.name); });
      raw.roles.forEach((r) => (Array.isArray(r.assigned) ? r.assigned : []).forEach((v) => {
        const shifts = w ? v.Assignments || [] : [];
        // Someone in a role with no shift set yet counts on every day of the event.
        if (!shifts.length) { eventDays.forEach((pos) => dayAt(at(pos)).people.add(v.PeopleID)); return; }
        shifts.forEach((a) => {
          for (let pos = a.StartingPosition; pos < a.StartingPosition + (a.PositionsSpanned || 1); pos++) {
            const x = dayAt(at(pos));
            x.people.add(v.PeopleID);
            if (pos < lead && !x.setups.includes(ev.name)) x.setups.push(ev.name);
          }
        });
      }));
    });
    return [...days.values()].filter((x) => x.people.size || x.goal).sort((a, b) => a.d - b.d);
  }

  // Shirt sizes in their usual order, whatever words VMS puts around them ("Adult M", "Youth L"…).
  const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'];
  const sizeRank = (s) => {
    const t = s.toUpperCase().replace(/\bXXL\b/, '2XL').replace(/\bXXXL\b/, '3XL').replace(/\bSMALL\b/, 'S').replace(/\bMEDIUM\b/, 'M').replace(/\bLARGE\b/, 'L');
    const youth = /YOUTH|CHILD|KID/.test(t) ? 0 : 100;
    const hit = SIZE_ORDER.map((x, i) => [x, i]).reverse().find(([x]) => new RegExp('(^|[^A-Z0-9])' + x + '([^A-Z0-9]|$)').test(t));
    return hit ? youth + hit[1] : 1000;
  };

  function headcountCard() {
    const daily = dailyHeadcount();
    const raws = [...new Set(state.loaded.map((l) => l.src))];
    const chosen = raws.filter((raw) => !state.hcOff.has(raw.ev.id));
    const ids = new Set();
    chosen.forEach((raw) => raw.roles.forEach((r) => (Array.isArray(r.assigned) ? r.assigned : []).forEach((v) => ids.add(v.PeopleID))));
    const sizes = new Map();
    let unread = 0, none = 0;
    ids.forEach((id) => {
      const pr = profiles.get(id);
      if (!pr) { unread++; return; }
      const s = (pr.shirt || '').trim();
      if (!s) { none++; return; }
      sizes.set(s, (sizes.get(s) || 0) + 1);
    });
    const sizeList = [...sizes].sort((a, b) => sizeRank(a[0]) - sizeRank(b[0]) || a[0].localeCompare(b[0]));
    const md = (d) => WEEKDAYS[d.getDay()] + ' ' + (d.getMonth() + 1) + '/' + d.getDate();

    return h('details', { class: 'card hc', open: state.hcOpen, ontoggle: (e) => { state.hcOpen = e.target.open; } },
      h('summary', {}, 'Headcount for food and shirts'),
      h('div', { class: 'hcgrid' },
        h('section', {},
          h('h3', {}, 'Food: people on site each day'),
          daily.length ? h('table', { class: 'hct' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Day'), h('th', {}, 'People'), h('th', {}, 'Goal'), h('th', {}, 'Events'))),
            h('tbody', {}, daily.map((x) => h('tr', {},
              h('td', {}, md(x.d), !x.events.length ? h('span', { class: 'sub' }, ' setup') : null),
              h('td', { class: 'num' + (x.goal && x.people.size < x.goal ? ' lo' : x.goal ? ' hi' : '') }, String(x.people.size)),
              h('td', { class: 'num' }, x.goal ? String(x.goal) : '—'),
              h('td', { class: 'sub' }, [...x.events, ...x.setups.map((n) => 'Setup: ' + n)].join(' · '))))))
            : h('div', { class: 'sub' }, 'No event dates to count by.'),
          h('div', { class: 'sub hcnote' }, 'Everyone assigned counts once a day, even in two roles or at two events. Anyone in a role with no shift set yet counts on every day of that event. '
            + 'Goal is the event’s role targets added up, so someone filling two roles counts once here but fills two targets.')),
        h('section', {},
          h('h3', {}, 'Shirts: different people across events'),
          raws.length > 1 ? h('div', { class: 'hcevs' }, raws.map((raw) => h('label', {},
            h('input', { type: 'checkbox', checked: !state.hcOff.has(raw.ev.id),
              onchange: (e) => { e.target.checked ? state.hcOff.delete(raw.ev.id) : state.hcOff.add(raw.ev.id); renderMain(); } }),
            ' ' + evLabel(raw.ev)))) : null,
          h('div', { class: 'hcbig' }, h('span', { class: 'num' }, String(ids.size)), ids.size === 1 ? ' person' : ' people',
            h('span', { class: 'sub' }, ' assigned to ' + (chosen.length === raws.length ? (raws.length > 1 ? 'any of these events' : 'this event') : plural(chosen.length, 'chosen event')) + ', each counted once')),
          sizeList.length ? h('div', {}, sizeList.map(([s, n]) => chip('plain', s + ': ' + n))) : null,
          unread || none ? h('div', { class: 'sub' },
            [unread ? h('span', {}, h('span', { class: 'spin', 'aria-hidden': 'true' }), 'Sizes still loading for ' + unread + (unread === 1 ? ' person' : ' people')) : null,
              unread && none ? ' · ' : null, none ? none + ' gave no size' : null]) : null,
          h('div', { class: 'sub hcnote' }, 'Shirt sizes come from each person’s VMS profile, read in the background after loading.'))));
  }

  // ----- Add a custom role (Roles tab) -----

  function addRoleForm() {
    const nr = state.newRole;
    if (!nr.open) return null;
    const loaded = state.loaded;
    const evIds = nr.evs || new Set(loaded.map((l) => l.ev.id));
    const picked = loaded.filter((l) => evIds.has(l.ev.id));
    const again = () => { nr.confirming = false; renderMain(); };
    const check = () => {
      const name = nr.name.trim();
      if (!name) return 'Enter a name for the role.';
      if (!/^\d{1,3}$/.test(String(nr.target).trim()) || Number(nr.target) > 200) return 'Target must be a whole number from 0 to 200.';
      if (!picked.length) return 'Tick at least one event.';
      const clash = picked.filter((l) => l.roles.some((r) => r.name.toLowerCase() === name.toLowerCase()));
      if (clash.length) return 'A role called "' + name + '" already exists on ' + clash.map((l) => evShort(l.ev)).join(' and ') + '.';
      return '';
    };
    return h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Add a role'),
      nr.error ? h('div', { class: 'msg err' }, nr.error) : null,
      h('label', { class: 'field' }, h('span', {}, 'Name'),
        h('input', { type: 'text', value: nr.name, disabled: nr.saving, oninput: (e) => { nr.name = e.target.value; nr.error = ''; } })),
      h('label', { class: 'field' }, h('span', {}, 'Target'),
        h('input', { type: 'number', class: 'tgt', min: 0, max: 200, step: 1, value: nr.target, disabled: nr.saving, oninput: (e) => { nr.target = e.target.value; nr.error = ''; } })),
      h('label', { class: 'field' }, h('span', {}, 'Description'),
        h('textarea', { rows: 3, value: nr.desc, disabled: nr.saving, placeholder: 'What the role involves. Include a minimum age if there is one.',
          oninput: (e) => { nr.desc = e.target.value; } })),
      h('label', { class: 'field' }, h('input', { type: 'checkbox', checked: nr.allow, disabled: nr.saving,
        onchange: (e) => { nr.allow = e.target.checked; again(); } }), ' Let volunteers apply for this role'),
      h('div', { class: 'field' }, h('span', {}, 'Add to'),
        loaded.map((l) => h('label', { style: 'margin-right:16px' }, h('input', { type: 'checkbox', checked: evIds.has(l.ev.id), disabled: nr.saving,
          onchange: (e) => { const next = new Set(evIds); e.target.checked ? next.add(l.ev.id) : next.delete(l.ev.id); nr.evs = next; again(); } }), ' ' + evLabel(l.ev)))),
      h('div', { class: 'bar', style: 'margin-bottom:0' },
        nr.confirming
          ? [h('strong', {}, 'Add "' + nr.name.trim() + '" to ' + plural(picked.length, 'event') + ' in VMS?'),
            h('button', { class: 'primary', disabled: nr.saving, onclick: () => saveNewRole(picked) }, nr.saving ? 'Adding…' : 'Yes, add'),
            h('button', { disabled: nr.saving, onclick: again }, 'Cancel')]
          : h('button', { class: 'primary', onclick: () => {
              nr.error = check();
              nr.confirming = !nr.error;
              renderMain();
            } }, 'Add role…')));
  }

  async function saveNewRole(picked) {
    const nr = state.newRole;
    nr.saving = true; renderMain();
    const failed = [];
    let ok = 0;
    const touched = new Map();
    const done = new Set();
    for (const { ev } of picked) {
      mark(touched, ev.id, nr.name.trim());
      if (done.has(ev.vmsId)) continue;
      done.add(ev.vmsId);
      try {
        await postJson('/VMS/Services/CustomRoleService.asmx/AddCustomRole', {
          ID: 0, eventID: ev.vmsId, Target: String(Number(nr.target)), Name: nr.name.trim(), Description: nr.desc.trim(), IsHidden: !nr.allow,
        });
        ok += 1;
      } catch (e) {
        failed.push(evShort(ev) + ' (' + e.message + ')');
      }
    }
    await reloadEvents(touched);
    nr.saving = false; nr.confirming = false;
    nr.result = { ok, failed };
    if (!failed.length) { nr.open = false; nr.name = ''; nr.desc = ''; nr.target = '1'; }
    render();
  }

  // Express Volunteer links and their QR codes come from the same VMS page, so one read gives both.
  // They are remembered, so a second click is instant.
  const inviteCache = new Map();
  async function inviteData(ev, r) {
    const key = ev.vmsId + ':' + (r ? (r.custom ? 'c' : 's') + r.id : 'event');
    if (inviteCache.has(key)) return inviteCache.get(key);
    const { doc } = await fetchDoc('/VMS/ExpressInvite.aspx?EventId=' + ev.vmsId
      + (r ? '&RoleId=' + r.id + '&IsCustom=' + (r.custom ? 'True' : 'False') : ''));
    const m = /https:\/\/my\.firstinspires\.org\/ExpressVolunteer\/[^\s"'<]+/.exec(doc.body ? doc.body.innerHTML : '');
    if (!m) throw new Error('VMS did not give a link for this');
    const img = doc.querySelector('#qr_code');
    const qr = img && /^data:image\/png;base64,/.test(img.getAttribute('src') || '') ? img.getAttribute('src') : '';
    const data = { url: m[0], qr };
    inviteCache.set(key, data);
    return data;
  }

  // Animates the clicked button while `work` runs: "Copying…", then a green "✓ Copied" or a red "Could not copy".
  // Only the button changes, so the page stays where it is.
  async function flashCopy(btn, work) {
    if (btn && btn.dataset.busy) return null; // already working on this button
    const text = btn ? btn.dataset.text || btn.textContent : '';
    if (btn) {
      btn.dataset.busy = '1'; btn.dataset.text = text;
      btn.style.minWidth = btn.offsetWidth + 'px';
      btn.classList.remove('copied', 'failed'); btn.classList.add('copying');
      btn.textContent = 'Copying…';
    }
    let ok = true;
    try { await work(); } catch (e) { ok = false; }
    if (btn) {
      btn.classList.remove('copying'); btn.classList.add(ok ? 'copied' : 'failed');
      btn.textContent = ok ? '✓ Copied' : 'Could not copy';
      setTimeout(() => {
        btn.classList.remove('copied', 'failed'); btn.textContent = text; btn.style.minWidth = ''; delete btn.dataset.busy;
      }, 1600);
    }
    return ok;
  }

  // A plain-text report for bug reports: version, what is loaded, request counts and recent errors.
  // It deliberately leaves out volunteer names, emails and ages.
  function diagnosticsText() {
    let version = 'unknown (not installed)';
    try { version = chrome.runtime.getManifest().version; } catch (e) { /* injected copy */ }
    const chromeV = (/Chrome\/(\d+)/.exec(navigator.userAgent) || [])[1] || '?';
    const stamp = (t) => { const d = new Date(t); return d.toLocaleDateString() + ' ' + d.toTimeString().slice(0, 8); };
    const lines = ['VMS+ diagnostics', 'Version ' + version + ' · Chrome ' + chromeV + ' · ' + stamp(Date.now()), ''];
    const srcs = [...new Set(state.loaded.map((l) => l.src))];
    lines.push('Events loaded: ' + srcs.length + (state.busy ? ' (still loading: ' + (state.progress || '') + ')' : ''));
    srcs.forEach((raw) => {
      const ev = raw.ev;
      const cols = state.loaded.filter((l) => l.src === raw).length;
      const roles = raw.roles.filter((r) => !r.admin);
      const assigned = roles.reduce((t, r) => t + (Array.isArray(r.assigned) ? r.assigned.length : 0), 0);
      const applicants = roles.reduce((t, r) => t + (Array.isArray(r.applicants) ? r.applicants.length : 0), 0);
      const failed = roles.filter((r) => r.readFailed).length;
      const quiet = roles.filter((r) => r.unchecked).length;
      lines.push('- Event ' + ev.vmsId + ' · ' + (ev.program || '?') + ' · ' + (ev.date || '?') + ' · ' + plural(ev.days || 1, 'day')
        + (cols > 1 ? ' shown as ' + cols + ' columns' : '') + ' · ' + plural(roles.length, 'role') + ' · '
        + assigned + ' assignments · ' + applicants + ' applications'
        + (failed ? ' · ' + failed + ' applicant lists failed' : '') + (quiet ? ' · ' + quiet + ' roles still checking' : '')
        + (raw.extrasPending ? ' · training/last season still loading' : ''));
    });
    const sel = state.events.filter((e) => state.selected.has(e.id));
    if (sel.length !== srcs.length) lines.push('Ticked but not loaded: ' + sel.filter((e) => !srcs.some((r) => r.ev.vmsId === e.vmsId)).map((e) => e.vmsId).join(', '));
    lines.push('');
    const total = Object.values(diag.requests).reduce((a, b) => a + b, 0);
    lines.push('Requests to VMS since ' + stamp(diag.since) + ': ' + total);
    Object.entries(diag.requests).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => lines.push('- ' + k + ': ' + n + ' (slowest ' + ((diag.ms[k] || 0) / 1000).toFixed(1) + 's)'));
    lines.push('Rate-limit pause: ' + (Date.now() < blockedUntil ? 'active, ' + Math.ceil((blockedUntil - Date.now()) / 1000) + 's left' : 'none'));
    lines.push('');
    lines.push('Recent errors: ' + (diag.errors.length ? '' : 'none'));
    diag.errors.forEach((x) => lines.push('- ' + stamp(x.t) + ' · ' + x.key + ' · ' + x.what));
    if (state.error) lines.push('Message shown: ' + state.error);
    lines.push('');
    lines.push('Tab: ' + state.tab + ' · theme ' + state.theme + ' · hide no-target roles ' + (state.hideZero ? 'on' : 'off')
      + ' · minimum ages ' + (state.showAges ? 'on' : 'off') + ' · hide past ' + (state.hidePast ? 'on' : 'off') + ' · setup days ' + (state.showSetup ? 'on' : 'off') + ' · staffing view ' + state.staffMode);
    lines.push('Screen ' + window.innerWidth + '×' + window.innerHeight);
    return lines.join('\n');
  }
  const copyDiagnostics = (btn) => flashCopy(btn, () => navigator.clipboard.writeText(diagnosticsText()));

  async function copyInvite(ev, r, btn) {
    const label = (r ? r.name + ' on ' : 'Whole event, ') + evShort(ev);
    let url = '', err = '';
    const ok = await flashCopy(btn, async () => {
      try { url = (await inviteData(ev, r)).url; } catch (e) { err = e.message; throw e; }
      await navigator.clipboard.writeText(url);
    });
    if (ok !== false) return;
    // Only when copying fails: show the link (or the error) so it can be copied by hand.
    state.inviteLink = url ? { label, url, copied: false } : { label, url: '', error: err || 'Could not copy' };
    renderMain();
  }

  // Copies the event's QR code image (a PNG, ready to paste into a flyer or slide), then opens VMS's QR page as before.
  async function copyQr(ev, btn) {
    const page = '/VMS/ExpressInvite.aspx?EventId=' + ev.vmsId;
    const ok = await flashCopy(btn, async () => {
      const { qr } = await inviteData(ev, null);
      if (!qr) throw new Error('No QR code on the VMS page');
      const blob = await (await fetch(qr)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    });
    if (ok === null) return;
    // Open the page behind the dashboard when installed; otherwise in a new tab.
    if (!(canBackground() && await backgroundOpen(location.origin + page))) window.open(page, '_blank');
  }
  const backgroundOpen = (url) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'vc-open', url }, (res) => resolve(!chrome.runtime.lastError && !!res && !!res.ok));
    } catch (e) { resolve(false); }
  });

  // Standard roles only: VMS handles custom roles' visibility on its Manage Custom Roles page.
  async function toggleApplications(ev, r, allow) {
    state.toggling = true; renderMain();
    try {
      await postJson('/VMS/Roles/RoleDetails.aspx/SetVIMSVisibility', { Value: allow, EventID: ev.vmsId, RoleID: r.id });
      await reloadEvents(new Map([[ev.id, new Set()]]));
      state.targetResult = null;
      toast(r.name + ' on ' + evShort(ev) + (allow ? ' is open to applications again.' : ' no longer accepts applications.'));
    } catch (e) { state.error = e.message; }
    state.toggling = false; state.toggleKey = '';
    render();
  }

  async function applyTargets() {
    state.targetApplying = true; renderMain();
    const failed = [];
    let ok = 0;
    const touched = new Map();
    const done = new Set();
    for (const { ev, r, value } of state.targetEdits.values()) {
      mark(touched, ev.id);
      const once = ev.vmsId + ':' + r.id + ':' + r.custom;
      if (done.has(once)) continue;
      done.add(once);
      try {
        await svcPost('UpdateTarget', { eventID: ev.vmsId, roleID: r.id, isCustom: r.custom, target: value });
        ok += 1;
      } catch (e) {
        failed.push(r.name + ' on ' + (ev.multi ? ev.name + ' (every day)' : evShort(ev)) + ' (' + e.message + ')');
      }
    }
    await reloadEvents(touched);
    state.targetEdits.clear();
    state.targetApplying = false; state.targetConfirm = false; state.targetEdit = false;
    state.targetResult = { ok, failed };
    render();
  }

  // ----- People tab -----

  const STATUS = [
    ['all', 'Everyone'],
    ['assigned', 'Assigned'],
    ['unassigned', 'Applicants not assigned anywhere'],
    ['unnotified', 'Not notified yet'],
    ['allday', 'Shift is 6am–10pm'],
    ['noshift', 'On schedule, no shift set'],
    ['partial', 'Assigned some days only'],
    ['rolediff', 'Role differs by day'],
    ['todo', 'Anything outstanding (clearance, training, consent)'],
    ['training', 'Required training incomplete'],
    ['consent', 'Consent not signed'],
    ['returning', 'Here last season'],
    ['clearance', 'Needs clearance'],
    ['minor', 'Minors'],
    ['adult', 'Adults only'],
  ];

  function matches(p) {
    const s = state.status;
    if (s === 'assigned' && !p.assignedAnywhere) return false;
    if (s === 'unassigned' && p.assignedAnywhere) return false;
    if (s === 'adult' && p.flags.includes('minor')) return false;
    if (FLAG_LABEL[s] && !p.flags.includes(s)) return false;
    if (s === 'todo' && !owed(p).length) return false;
    if (state.role) {
      const inRole = Object.values(p.ev).some((e) =>
        e.assign.some((a) => a.role === state.role) || (!p.assignedAnywhere && e.applied.some((a) => a.role === state.role)));
      if (!inRole) return false;
    }
    if (state.search) {
      const q = state.search.toLowerCase();
      if (!(p.first + ' ' + p.last + ' ' + p.email).toLowerCase().includes(q)) return false;
    }
    return true;
  }

  function peopleView() {
    const loaded = state.loaded;
    const shown = state.people.filter(matches);
    if (state.sort !== 'name') {
      const dir = state.sort === 'oldest' ? 1 : -1;
      // People with no known date go last either way.
      shown.sort((a, b) => (a.appliedOn == null) - (b.appliedOn == null) || dir * ((a.appliedOn || 0) - (b.appliedOn || 0)));
    }
    const roleNames = [...new Set(loaded.flatMap(({ roles }) => roles.map((r) => r.name)))].sort();
    const emails = [...new Set(shown.map((p) => p.email).filter(Boolean))];
    const remind = ['todo', 'clearance', 'training', 'consent'].includes(state.status) ? state.status : '';

    const evCell = (ev, p) => {
      const e = p.ev[ev.id];
      if (!e) return h('td', { class: 'muted' }, '—');
      const out = [];
      e.assign.forEach((a) => {
        if (!a.shifts.length) out.push(h('div', { class: 'line' }, h('strong', {}, a.role), ' ', a.admin ? null : chip('warn', 'No shift set')));
        a.shifts.forEach((s) => out.push(h('div', { class: 'line' },
          h('strong', {}, a.role), ' ', s.time, ' ',
          s.shadow ? chip('info', 'Shadow') : null,
          s.notified ? chip('ok', 'Notified') : chip('warn', 'Not notified'))));
      });
      if (e.applied.length) {
        out.push(h('div', { class: 'sub' }, 'Applied: ' + e.applied
          .slice().sort((a, b) => String(a.pref).localeCompare(String(b.pref), undefined, { numeric: true }))
          .map((a) => a.role + (a.pref ? ' (#' + a.pref + ')' : '')).join(', ')));
      }
      if (e.appliedOn) out.push(h('div', { class: 'sub' }, 'Applied on ' + fmtDay(e.appliedOn)));
      return h('td', {}, out);
    };

    return h('div', {},
      h('div', { class: 'bar' },
        h('input', { type: 'search', placeholder: 'Search name or email', value: state.search,
          oninput: (e) => { state.search = e.target.value; refreshPeople(); } }),
        h('select', { onchange: (e) => { state.status = e.target.value; renderMain(); } },
          STATUS.map(([v, l]) => h('option', { value: v, selected: state.status === v }, l))),
        h('select', { onchange: (e) => { state.role = e.target.value; renderMain(); } },
          h('option', { value: '' }, 'Any role'),
          roleNames.map((r) => h('option', { value: r, selected: state.role === r }, r))),
        h('select', { title: 'Sort', onchange: (e) => { state.sort = e.target.value; renderMain(); } },
          [['name', 'Sort by name'], ['oldest', 'Applied earliest first'], ['newest', 'Applied latest first']]
            .map(([v, l]) => h('option', { value: v, selected: state.sort === v }, l))),
        h('span', { class: 'muted grow' }, shown.length + ' of ' + state.people.length + ' people'),
        h('button', { class: 'primary', disabled: !emails.length, onclick: () => copyEmails(emails) },
          'Copy ' + emails.length + (emails.length === 1 ? ' email' : ' emails') + ' for BCC'),
        h('button', { disabled: !shown.length, title: 'One row per person, with each day\u2019s role and shift side by side', onclick: () => downloadRoster(shown) }, 'Download roster'),
        h('button', { disabled: !shown.length, title: 'Copies the same roster; paste into cell A1 of a sheet', onclick: () => copyRoster(shown) }, 'Copy for Sheets')),
      remind ? h('div', { class: 'msg' },
        h('strong', {}, 'Reminders. '),
        'Draft email opens one message per person covering everything they still owe: clearance, required training and the consent form, '
          + 'whichever apply. Nothing is sent until you send it. To write to everyone at once, copy the emails for BCC and ',
        h('a', { href: '#', onclick: (e) => {
          e.preventDefault();
          copyText(reminderText(remind === 'todo' ? REMIND_KINDS : [remind], null).body, 'Copied the reminder text.');
        } }, 'copy the general reminder text'), '.',
        (() => {
          const todo = shown.filter((p) => p.email && owed(p).length && !draftedWhen(p));
          const done = shown.filter((p) => draftedWhen(p)).length;
          return h('div', { class: 'bar', style: 'margin:8px 0 0' },
            h('button', { class: 'primary', disabled: !todo.length || state.drafting, onclick: () => draftBatch(todo) },
              state.drafting ? 'Opening drafts…' : !todo.length ? 'All drafted' : state.mailer === 'default' ? 'Draft next (' + todo.length + ' left)'
                : todo.length <= DRAFT_BATCH ? 'Draft all ' + todo.length : 'Draft next ' + DRAFT_BATCH + ' of ' + todo.length),
            h('span', {}, !state.mailer ? 'Opens each person\u2019s draft in your email. Review and send them there.'
              : state.mailer === 'default' ? 'Opens each person\u2019s draft in your email app, one at a time.'
                : 'Opens each person\u2019s draft in a background ' + mailerName() + ' tab. Review and send them there.'),
            done ? h('button', { class: 'lnk', title: 'Lets you draft these people again, for a second round of reminders',
              onclick: () => { shown.forEach((p) => REMIND_KINDS.forEach((k) => { if (state.reminded[k]) delete state.reminded[k][p.id]; })); renderMain(); } },
              'Clear drafted marks (' + done + ')') : null);
        })()) : null,
      h('table', { class: 'ptable' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Volunteer'), loaded.map(({ ev }) => h('th', {}, evLabel(ev))), h('th', {}, 'Flags'), remind ? h('th', {}, 'Reminder') : null)),
        h('tbody', {}, shown.map((p) => h('tr', {},
          h('td', {},
            nameLink(p),
            h('div', { class: 'sub' }, p.email + (p.age != null ? ' · age ' + p.age : ''))),
          loaded.map(({ ev }) => evCell(ev, p)),
          h('td', {}, p.flags.map((f) => chip(FLAG_TONE[f], FLAG_LABEL[f], f === 'clearance' ? p.clearance : ''))),
          remind ? h('td', {}, (() => {
            const kinds = owed(p);
            const when = draftedWhen(p);
            return [
              h('button', { disabled: !p.email || !kinds.length, onclick: () => draftReminder(p) }, when ? 'Draft again' : 'Draft email'),
              h('div', { class: 'sub' }, 'Covers ' + kinds.map((k) => REMIND_NAME[k]).join(', ') + (when ? ' · drafted ' + fmtDay(when) : '')),
            ];
          })()) : null)))));
  }

  // ----- Find tab -----
  // VMS's own volunteer search only knows people who have been assigned to an event at least once: applicants who
  // have never been assigned can't be found there at all. So this searches everyone who applied to or is assigned at
  // any of your events, from two reports per event: applications, then assignments (read once per session, one at a
  // time, results filling in as they arrive). VMS's own search is offered below, for anyone else.
  const find = { q: '', reading: false, failed: new Set(), stopped: '', vms: null };
  let findResEl = null;
  const findEvents = () => shownEvents();
  const fold = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const findWords = (q) => fold(q).split(/[\s,;]+/).filter(Boolean);

  // Every word typed must appear somewhere in their names or email, in any order and as part of a word.
  function findMatches(words) {
    const people = new Map();
    findEvents().forEach((ev) => {
      // Applications first; an assignment adds a role only when it isn't one of their applications already.
      [appIndex.get(ev.id), asgIndex.get(ev.id)].forEach((entry) => {
        if (!entry) return;
        entry.rows.forEach((r) => {
          const hay = fold([r.pref, r.legal, r.last, r.email].join(' '));
          if (!words.every((w) => hay.includes(w))) return;
          const key = r.email || fold(r.legal + ' ' + r.last);
          if (!people.has(key)) people.set(key, { ...r, apps: [] });
          const p = people.get(key);
          const same = p.apps.find((a) => a.ev === ev && a.role.toLowerCase() === r.role.toLowerCase());
          if (same) { if (/^applied$/i.test(same.status) && r.status === 'Assigned') same.status = 'Assigned'; return; }
          p.apps.push({ ev, role: r.role, status: r.status });
          ['city', 'st', 'age'].forEach((k) => { if (!p[k] && r[k]) p[k] = r[k]; });
        });
      });
    });
    // Whole-name matches first ("Doe" before "Doering"), then by last name.
    const whole = (p) => { const names = fold([p.pref, p.legal, p.last].join(' ')).split(/[\s-]+/); return words.every((w) => names.includes(w)) ? 0 : 1; };
    const first = (p) => fold(p.pref || p.legal);
    return [...people.values()].sort((a, b) => whole(a) - whole(b) || fold(a.last).localeCompare(fold(b.last)) || first(a).localeCompare(first(b)));
  }

  // Every event's applications come first, so applicants show up soonest; then every event's assignments.
  const findPending = (j) => !(j.kind === 'app' ? appIndex : asgIndex).has(j.ev.id) && !find.failed.has(j.kind + ':' + j.ev.id);
  const findJobs = () => ['app', 'asg'].flatMap((kind) => findEvents().map((ev) => ({ kind, ev }))).filter(findPending);
  async function readAllApplicants() {
    if (find.reading) return;
    find.reading = true; find.stopped = '';
    refreshFind();
    try {
      for (;;) {
        const job = findJobs()[0];
        if (!job) break;
        // A details pane someone just opened, or a Load, goes first.
        while (paneBusy > 0 || state.busy) await pause(300);
        if (!findPending(job)) continue;
        try { await (job.kind === 'app' ? appReport : asgReport)(job.ev.id); } catch (e) {
          if (Date.now() < blockedUntil) { find.stopped = e.message; break; }
          find.failed.add(job.kind + ':' + job.ev.id);
        }
        refreshFind();
      }
    } finally { find.reading = false; refreshFind(); }
  }
  // Redraw the results without touching the search box, so typing is never interrupted.
  function refreshFind() {
    if (state.tab !== 'find' || !findResEl || !findResEl.isConnected) return;
    findResEl.replaceChildren(...findBody());
  }

  function findView() {
    if (findJobs().length && !find.stopped) setTimeout(readAllApplicants, 0);
    findResEl = h('div', {}, findBody());
    return h('div', {},
      h('div', { class: 'bar' },
        h('input', { type: 'search', class: 'findq', 'data-fk': 'findq', value: find.q, placeholder: 'Name or email, any order: jane doe, doe jane, jan, @gmail',
          oninput: (e) => { find.q = e.target.value; refreshFind(); } })),
      findResEl);
  }

  function findBody() {
    const evs = findEvents();
    const total = evs.length * 2;
    const done = evs.filter((ev) => appIndex.has(ev.id)).length + evs.filter((ev) => asgIndex.has(ev.id)).length;
    const failed = evs.filter((ev) => find.failed.has('app:' + ev.id) || find.failed.has('asg:' + ev.id));
    const out = [];
    out.push(h('div', { class: 'sub findstat' },
      !state.events.length ? (state.busy ? 'Finding your events…' : 'No events to search.')
        : find.reading ? [h('span', { class: 'spin', 'aria-hidden': 'true' }), 'Reading who applied to and is assigned at your events: ' + done + ' of ' + total + ' lists done. Results fill in as each one arrives.']
          : 'Searching everyone who applied to or is assigned at your ' + plural(evs.length, 'event') + '.',
      state.hidePast && state.events.some(isPast) ? ' Past events are left out; choose Show past in the event list to search them too.' : '',
      !find.reading && done ? [' ', h('button', { class: 'lnk', title: 'Read the lists again, to pick up new applications and assignments',
        onclick: () => { appIndex.clear(); asgIndex.clear(); find.failed.clear(); readAllApplicants(); } }, 'Read again')] : null));
    if (find.stopped) out.push(h('div', { class: 'msg err' }, find.stopped, ' ',
      h('button', { class: 'lnk', onclick: () => { find.stopped = ''; readAllApplicants(); } }, 'Try again')));
    if (failed.length && !find.reading) out.push(h('div', { class: 'msg err' },
      'VMS couldn’t send everyone who applied to or is assigned at ' + failed.map((ev) => ev.name).join(', ') + ', so some people there may be missing. ',
      h('button', { class: 'lnk', onclick: () => { find.failed.clear(); readAllApplicants(); } }, 'Try again')));

    const words = findWords(find.q);
    if (!words.length) {
      out.push(h('div', { class: 'msg' }, 'Type part of a name or email. This finds anyone who applied to or is assigned at your events, including people who have never been assigned anywhere. VMS’s own volunteer search can’t find those.'));
      return out;
    }
    const found = findMatches(words);
    const SHOW = 100;
    out.push(h('div', { class: 'muted', style: 'margin: 8px 0 4px' },
      (found.length === 1 ? '1 match' : found.length + ' matches') + (find.reading ? ' so far' : '')
      + (found.length > SHOW ? ', showing the first ' + SHOW + '. Type more to narrow it down.' : '')));
    found.slice(0, SHOW).forEach((p) => out.push(foundRow(p)));
    out.push(vmsSection());
    return out;
  }

  const statusTone = (s) => (/^assigned/i.test(s) ? 'ok' : /tentative/i.test(s) ? 'info' : 'plain');
  function foundRow(p) {
    const name = (p.pref || p.legal) + ' ' + p.last;
    // Someone in the loaded events gets the details pane, like everywhere else.
    const here = p.email ? state.people.find((x) => (x.email || '').toLowerCase() === p.email) : null;
    const byEvent = new Map();
    p.apps.forEach((a) => { if (!byEvent.has(a.ev)) byEvent.set(a.ev, []); byEvent.get(a.ev).push(a); });
    return h('div', { class: 'frow' },
      h('div', {},
        here ? nameLink(here, name)
          : h('button', { class: 'lnk pname', title: 'Open their VMS profile in a new tab', onclick: (e) => openFoundProfile(p, e.currentTarget) }, name),
        p.legal && p.pref && fold(p.legal) !== fold(p.pref) ? h('span', { class: 'sub' }, ' (legal name ' + p.legal + ')') : null,
        h('div', { class: 'sub' }, [p.email, p.age ? 'age ' + p.age : '', [p.city, p.st].filter(Boolean).join(', ')].filter(Boolean).join(' · '))),
      h('div', {}, [...byEvent].map(([ev, apps]) => h('div', { class: 'line' },
        h('a', { href: '/VMS/Events/EventDetails.aspx?ID=' + ev.id, target: '_blank', title: 'Open the event in VMS' }, evLabel(ev)), ' ',
        apps.map((a) => chip(statusTone(a.status), a.role + (a.status && !/^applied$/i.test(a.status) ? ' · ' + a.status : ''), a.status))))));
  }

  // The application report has no ID numbers, so their profile link comes from a role list they're on.
  const foundUrls = new Map(), eventRoles = new Map();
  async function profileUrlFor(p) {
    if (foundUrls.has(p.email)) return foundUrls.get(p.email);
    for (const a of p.apps) {
      if (!eventRoles.has(a.ev.id)) eventRoles.set(a.ev.id, await svc('GetRoles', { eventID: a.ev.id, roleType: 0 }, true));
      const role = (eventRoles.get(a.ev.id) || []).find((r) => cleanRole(r.Name).toLowerCase() === a.role.toLowerCase());
      if (!role) continue;
      const lists = [
        ['GetAssignedVolunteers', { eventID: a.ev.id, roleID: role.ID, isCustom: !!role.IsCustom, viewType: 'Event', day: 0 }],
        ['GetUnassignedVolunteers', { eventID: a.ev.id, roleID: role.ID, tab: 'Applicants', isCustom: !!role.IsCustom }],
        ['GetUnassignedVolunteers', { eventID: a.ev.id, roleID: role.ID, tab: 'Hidden', isCustom: !!role.IsCustom }],
      ];
      if (/^applied/i.test(a.status)) lists.push(lists.shift());
      for (const [method, params] of lists) {
        const rows = await svc(method, params, true);
        const v = Array.isArray(rows) ? rows.find((x) => (x.Email || '').toLowerCase() === p.email) : null;
        if (v) {
          const url = '/VMS/Volunteers/VolunteerDetails.aspx?ID=' + a.ev.id + '&RoleID=' + role.ID
            + '&IsCustom=' + (role.IsCustom ? 'True' : 'False') + '&PeopleID=' + v.PeopleID;
          foundUrls.set(p.email, url);
          return url;
        }
      }
    }
    throw new Error('VMS didn’t list them under the roles they applied for');
  }
  async function openFoundProfile(p, btn) {
    // Open the tab now, while the click still counts, and send it to the profile once the link is known.
    const tab = window.open('about:blank', '_blank');
    btn.disabled = true;
    try {
      const url = await profileUrlFor(p);
      if (tab) tab.location.href = url; else window.open(url, '_blank');
    } catch (e) {
      if (tab) tab.close();
      toast('Couldn’t open their profile: ' + e.message);
    }
    btn.disabled = false;
  }

  // VMS's own search, used the way it works best: a first and last name together (trying each way a longer name
  // could split, since first names can be two words), or a full email. It only matches whole names.
  const VMS_SLOW = 'VMS took too long and gave up. That happens when a search is broad, like a single or common name. Add the first name, or search by full email.';
  async function vmsSearchOnce(fields) {
    const params = { pageNum: 0, pageSize: 100, sortField: 'Name', sortOrder: 'asc', firstName: '', lastName: '', email: '', searchPhrase: '', isWildCard: false, ...fields };
    const qs = Object.entries(params).map(([k, v]) => k + '=' + encodeURIComponent(typeof v === 'string' ? JSON.stringify(v) : v)).join('&');
    // No retries: a search VMS couldn't finish won't finish the second time either, and each try holds VMS up for a minute.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 75000);
    let res;
    await svcSlot(true);
    try {
      res = await vfetch(SVC + 'SearchVolunteers?' + qs, {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }, credentials: 'same-origin', signal: ctl.signal,
      });
    } catch (e) {
      throw e && e.name === 'AbortError' ? new Error(VMS_SLOW) : e;
    } finally { clearTimeout(timer); svcFree(); }
    if ([500, 502, 503, 504].includes(res.status)) throw new Error(VMS_SLOW);
    if (!res.ok) throw new Error('VMS search failed (HTTP ' + res.status + ')');
    let d;
    try { d = (await res.json()).d; } catch (e) { throw new Error('VMS session expired. Sign in again and reload.'); }
    if (d == null) throw new Error('VMS session expired. Sign in again and reload.');
    const r = typeof d === 'string' ? JSON.parse(d) : d;
    return Array.isArray(r.Items) ? r.Items : [];
  }
  async function searchVms(q, single) {
    if (!single && !/@/.test(q) && !q.includes(',') && q.split(/\s+/).filter(Boolean).length < 2) { find.vms = { q, ask: true }; refreshFind(); return; }
    find.vms = { q, running: true };
    refreshFind();
    const r = await vmsLookup(q);
    if (!find.vms || find.vms.q !== q) return;
    find.vms = { q, ...r };
    refreshFind();
  }
  // Every way of asking VMS for what was typed, merged: { items, error }.
  async function vmsLookup(q) {
    const words = q.split(/\s+/).filter(Boolean);
    const tries = [];
    if (/@/.test(q)) tries.push({ email: q });
    else if (q.includes(',')) {
      const [last, first] = q.split(',').map((t) => t.trim());
      if (first && last) tries.push({ firstName: first, lastName: last });
    } else if (words.length >= 2) {
      for (let i = 1; i < words.length; i++) {
        tries.push({ firstName: words.slice(0, i).join(' '), lastName: words.slice(i).join(' ') });
        tries.push({ firstName: words.slice(i).join(' '), lastName: words.slice(0, i).join(' ') });
      }
      // VMS's header search ("First Last" as typed) also takes the start of a first name ("jan doe"), which the name
      // boxes don't. It is just as quick when there is a last name to go on.
      tries.push({ searchPhrase: words.join(' '), isWildCard: true });
    }
    if (!tries.length) tries.push({ lastName: q });
    const seen = new Map();
    let failure = '';
    for (const t of tries) {
      try { (await vmsSearchOnce(t)).forEach((v) => seen.set(v.PeopleID, v)); } catch (e) {
        failure = e.message;
        if (Date.now() < blockedUntil || /session/i.test(failure)) break;
      }
    }
    return { items: [...seen.values()], error: seen.size ? '' : failure };
  }
  function vmsSection() {
    const q = find.q.trim();
    const v = find.vms && find.vms.q === q ? find.vms : null;
    const kids = [h('h2', {}, 'Search all of VMS')];
    if (!v) {
      kids.push(h('div', { class: 'sub', style: 'margin-bottom: 8px' },
        'Not here? VMS’s own search covers everyone you can see who has been assigned to an event at least once, including at events that aren’t yours. It needs a whole first and last name, or a full email address.'),
      h('button', { onclick: () => searchVms(q) }, 'Search VMS for “' + q + '”'));
    } else if (v.ask) {
      kids.push(h('div', { class: 'msg' }, 'VMS needs a first and last name, or a full email address. With a single name it checks everyone you can see, which can take a minute and often fails.'),
        h('button', { onclick: () => searchVms(q, true) }, 'Search VMS for last name “' + q + '” anyway'));
    } else if (v.running) {
      kids.push(h('div', { class: 'sub' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), 'Asking VMS…'));
    } else if (v.error) {
      kids.push(h('div', { class: 'msg err' }, v.error));
    } else if (!v.items.length) {
      kids.push(h('div', { class: 'sub' }, 'VMS found no one. It only knows people who have been assigned to an event at least once, and it often misses partial or misspelled names. Try the whole first and last name, or their full email.'));
    } else {
      kids.push(h('div', { class: 'muted', style: 'margin-bottom: 4px' }, v.items.length === 1 ? '1 person' : v.items.length + ' people'));
      v.items.forEach((x) => kids.push(h('div', { class: 'frow' },
        h('div', {},
          h('a', { class: 'pname', href: '/VMS/Volunteers/VolunteerDetails.aspx?PeopleID=' + x.PeopleID, target: '_blank', title: 'Open their VMS profile' },
            ((x.PreferredName || x.FirstName || '') + ' ' + (x.LastName || '')).trim() || x.Name),
          h('div', { class: 'sub' }, [x.Email, x.Age != null ? 'age ' + x.Age : '', [x.City, x.State].filter(Boolean).join(', ')].filter(Boolean).join(' · '))),
        h('div', { class: 'sub' }, x.LatestEventApplied ? 'Last applied to ' + x.LatestEventApplied + (x.LatestProgramApplied ? ' (' + x.LatestProgramApplied + ')' : '') : ''))));
    }
    return h('section', { class: 'card', style: 'margin-top: 16px' }, kids);
  }

  // ----- Reminders (People tab, when filtered to something a person still owes) -----

  const DASHBOARD_URL = 'https://my.firstinspires.org/Dashboard/';
  function missingTraining(p) {
    const out = [];
    state.loaded.forEach(({ ev }) => {
      const e = p.ev[ev.id];
      owedTraining(e).forEach((t) => {
        const line = (t.role ? t.role + ': ' : '') + t.course;
        if (!out.includes(line)) out.push(line);
      });
    });
    return out;
  }
  // The things a volunteer can still owe, in the order they are written in an email.
  const REMIND_KINDS = ['clearance', 'training', 'consent'];
  const REMIND_NAME = { clearance: 'clearance', training: 'training', consent: 'consent form' };
  const owed = (p) => REMIND_KINDS.filter((k) => p.flags.includes(k));

  // The text of a reminder covering `kinds`. With a person it is addressed to them; without, it is a general
  // version for a BCC email.
  function reminderText(kinds, p) {
    const evs = state.loaded.filter(({ ev }) => !p || (p.ev[ev.id] && (p.ev[ev.id].assign.length || !p.assignedAnywhere))).map(({ ev }) => ev);
    const names = [...new Set(evs.map((ev) => ev.name))];
    const where = names.length ? names.join(' and ') : 'our event';
    const hello = p && p.first ? 'Hi ' + p.first + ',' : 'Hello,';
    const items = [];
    if (kinds.includes('clearance')) {
      items.push({ title: 'Youth Protection screening', lines: ['Your FIRST Youth Protection screening is not complete yet, and you cannot be confirmed in a role until it is. '
        + 'Sign in to your FIRST Dashboard and follow the screening steps shown there.'] });
    }
    if (kinds.includes('training')) {
      const courses = p ? missingTraining(p) : [];
      items.push({ title: 'Required training', lines: ['Please complete the required training for your role' + (courses.length ? ':' : '.'), ...courses.map((c) => '- ' + c)] });
    }
    if (kinds.includes('consent')) {
      items.push({ title: 'Consent and Release form', lines: ['Your FIRST Consent and Release form has not been signed yet. Please sign it before the event.'] });
    }
    const one = items.length === 1;
    const subject = one
      ? { clearance: 'Youth Protection screening for ', training: 'Training to complete before ', consent: 'Consent and Release form for ' }[kinds[0]] + where
      : 'A few things to complete before ' + where;
    const intro = one ? 'There is one thing to take care of before the event.'
      : p ? 'There are ' + items.length + ' things to take care of before the event.'
        : 'One or more of the following may still be outstanding for you. Please check each one before the event.';
    const body = [hello, '', 'Thank you for volunteering at ' + where + '. ' + intro, ''];
    items.forEach((it, i) => { body.push((one ? '' : (i + 1) + '. ') + it.title, ...it.lines, ''); });
    body.push((one ? 'This is' : items.length === 2 ? 'Both of these are' : 'All of these are') + ' in your FIRST Dashboard: ' + DASHBOARD_URL, '', 'Thank you!');
    return { subject, body: body.join('\n') };
  }
  // When this person's current reminder was last drafted (0 = not yet).
  const draftedWhen = (p) => Math.max(0, ...owed(p).map((k) => (state.reminded[k] || {})[p.id] || 0));
  const markDrafted = (p) => owed(p).forEach((k) => {
    state.reminded[k] = state.reminded[k] || {};
    state.reminded[k][p.id] = Date.now();
  });
  const reminderMsg = (p) => ({ to: p.email, ...reminderText(owed(p), p) });
  // The extension's background script opens a draft in a tab behind this one.
  // It is only there in the installed extension, and not in a VMS tab left open from before the extension was reloaded.
  const canBackground = () => { try { return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id; } catch (e) { return false; } };
  const backgroundDraft = (url, offset) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'vc-draft', url, offset }, (res) => resolve(!chrome.runtime.lastError && !!res && !!res.ok));
    } catch (e) { resolve(false); }
  });
  // Where a new email opens, from the Email setting: a compose page for web mail, or a mailto: link for the
  // computer's own email app.
  const composeUrl = (m, mailer) => {
    const e = encodeURIComponent, to = m.to || '', subject = m.subject || '', body = m.body || '';
    if (mailer === 'gmail') {
      // With an address, Gmail opens in that signed-in account whatever its place in the account list.
      const who = (state.gmailAccount || '').trim();
      return 'https://mail.google.com/mail/' + (who ? '?authuser=' + e(who) + '&' : 'u/0/?') + 'view=cm&fs=1&tf=1&to=' + e(to) + '&su=' + e(subject) + '&body=' + e(body);
    }
    if (mailer === 'outlook') return 'https://outlook.office.com/mail/deeplink/compose?to=' + e(to) + '&subject=' + e(subject) + '&body=' + e(body);
    if (mailer === 'outlookcom') return 'https://outlook.live.com/mail/0/deeplink/compose?to=' + e(to) + '&subject=' + e(subject) + '&body=' + e(body);
    return 'mailto:' + e(to) + '?subject=' + e(subject) + '&body=' + e(body.replace(/\n/g, '\r\n'));
  };
  const mailerName = () => (MAILERS.find(([k]) => k === state.mailer) || [, 'your email'])[1]
    + (state.mailer === 'gmail' && state.gmailAccount ? ' (' + state.gmailAccount + ')' : '');
  // Open one email draft. Web mail opens behind this tab when it can (in front otherwise); the email app opens itself.
  async function openEmail(m, offset) {
    const url = composeUrl(m, state.mailer);
    if (url.startsWith('mailto:')) { h('a', { href: url }).click(); return 'app'; }
    if (canBackground() && await backgroundDraft(url, offset || 0)) return 'background';
    return window.open(url, '_blank', 'noopener') ? 'front' : '';
  }
  // Run an email action, asking once where email should open if that hasn't been chosen yet.
  function withMailer(fn) {
    if (state.mailer) { fn(); return; }
    state.mailerAsk = fn;
    render();
  }
  const looksLikeEmail = (t) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(t);
  function mailerChooser() {
    if (!state.mailerAsk) return null;
    let account = state.gmailAccount || '';
    let box = null, warn = null;
    const pick = (k) => {
      if (k === 'gmail' && account.trim() && !looksLikeEmail(account.trim())) { warn.hidden = false; box.focus(); return; }
      const then = state.mailerAsk;
      state.mailer = k;
      if (k === 'gmail') state.gmailAccount = account.trim();
      state.mailerAsk = null; saveDrafts(); render();
      toast('Email will open in ' + mailerName() + '. Change it any time with the Email menu at the top.');
      then();
    };
    return h('div', { class: 'mailask', role: 'dialog', 'aria-label': 'Where should email open?' },
      h('div', { class: 'mailbox' },
        h('strong', {}, 'Where should email open?'),
        h('div', { class: 'sub' }, 'VMS+ remembers this. You can change it any time with the Email menu at the top.'),
        h('div', { class: 'mailopts' }, MAILERS.map(([k, label, hint]) => [
          h('button', { onclick: () => pick(k) }, h('span', {}, label), h('small', {}, hint)),
          k === 'gmail' ? h('label', { class: 'gacct' }, h('span', {}, 'Signed into more than one Google account? Type the one to use:'),
            box = h('input', { type: 'email', value: account, placeholder: 'you@gmail.com (optional)',
              oninput: (e) => { account = e.target.value; warn.hidden = true; },
              onkeydown: (e) => { if (e.key === 'Enter') pick('gmail'); } }),
            warn = h('small', { class: 'bad', hidden: true }, 'That doesn\u2019t look like an email address.')) : null,
        ])),
        h('button', { class: 'lnk', onclick: () => { state.mailerAsk = null; render(); } }, 'Cancel')));
  }

  function draftReminder(p) {
    withMailer(async () => {
      const how = await openEmail(reminderMsg(p), 0);
      if (!how) { toast('Could not open the draft. Allow pop-ups for this page and try again.'); return; }
      markDrafted(p);
      renderMain();
      if (how === 'background') toast('Draft opened in a background tab.');
    });
  }

  // Open the next batch of drafts, each in its own background tab, in list order.
  const DRAFT_BATCH = 10;
  function draftBatch(todo) { withMailer(() => draftBatchNow(todo)); }
  async function draftBatchNow(todo) {
    if (state.mailer === 'default') {
      // An email app opens one draft per click, so do the first and let the button step through the rest.
      const p = todo[0];
      await openEmail(reminderMsg(p), 0);
      markDrafted(p); renderMain();
      toast('Opened the draft for ' + p.first + ' in your email app.' + (todo.length > 1 ? ' Click again for the next one.' : ''));
      return;
    }
    if (!canBackground()) {
      toast('Drafting several at once needs the installed extension. Reload this VMS page and try again.');
      return;
    }
    const batch = todo.slice(0, DRAFT_BATCH);
    state.drafting = true; renderMain();
    let opened = 0;
    for (const p of batch) {
      if (!await backgroundDraft(composeUrl(reminderMsg(p), state.mailer), opened)) break;
      markDrafted(p);
      opened += 1;
    }
    state.drafting = false;
    const left = todo.length - opened;
    toast(opened ? 'Opened ' + plural(opened, 'draft') + ' in background tabs.' + (left ? ' ' + left + ' still to draft.' : '')
      : 'Could not open drafts. Reload this VMS page and try again.');
  }

  // ----- Roster export (People tab) -----

  function rosterTable(shown) {
    const loaded = state.loaded;
    const head = ['Last name', 'First name', 'Email', 'Phone', 'Age', 'Shirt size', 'Pronouns'];
    loaded.forEach(({ ev }) => head.push(evShort(ev) + ' role', evShort(ev) + ' shift', evShort(ev) + ' notified'));
    head.push('Applied for', 'Flags');
    const rows = shown.map((p) => {
      const pr = profiles.get(p.id) || {};
      const row = [p.last, p.first, p.email, p.raw.PhoneNumber || '', p.age != null ? String(p.age) : '', pr.shirt || '', pr.pronouns || ''];
      loaded.forEach(({ ev }) => {
        const assign = p.ev[ev.id] ? p.ev[ev.id].assign : [];
        const shifts = assign.flatMap((a) => a.shifts);
        row.push(assign.map((a) => a.role).join('; '),
          [...new Set(shifts.map((x) => x.time).filter(Boolean))].join('; '),
          !shifts.length ? '' : shifts.every((x) => x.notified) ? 'Yes' : 'No');
      });
      row.push([...new Set(Object.values(p.ev).flatMap((e) => e.applied.map((a) => a.role)))].join('; '),
        p.flags.map((f) => FLAG_LABEL[f]).join('; '));
      return row;
    });
    return [head, ...rows];
  }
  function downloadRoster(shown) {
    const quote = (c) => (/[",\r\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c);
    const csv = '\ufeff' + rosterTable(shown).map((r) => r.map((c) => quote(String(c == null ? '' : c))).join(',')).join('\r\n') + '\r\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const d = new Date();
    const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const a = h('a', { href: url, download: 'volunteer-roster-' + stamp + '.csv' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('Downloaded a roster of ' + plural(shown.length, 'person').replace('persons', 'people') + '. The file contains personal details.');
  }
  function copyRoster(shown) {
    const flat = (c) => String(c == null ? '' : c).replace(/[\t\r\n]+/g, ' ');
    copyText(rosterTable(shown).map((r) => r.map(flat).join('\t')).join('\n'),
      'Copied a roster of ' + plural(shown.length, 'person').replace('persons', 'people') + '. Paste into cell A1.');
  }
  async function copyText(text, done) {
    try { await navigator.clipboard.writeText(text); toast(done); } catch (e) { toast('Could not copy: ' + e.message); }
  }

  // ----- Shared helpers for the tabs that write -----

  const evShort = (ev) => (ev.date ? (ev.setup ? 'Setup ' : '') + (ev.wd ? ev.wd + ' ' : '') + ev.date.replace(/\/\d{4}$/, '') : ev.name);
  // The VMS event behind a column id.
  const vmsEventOf = (key) => { const l = state.loaded.find((x) => String(x.ev.id) === String(key)); return l ? l.ev.vmsId : Number(key); };
  const fullName = (v) => ((v.PreferredName || v.FirstName || '') + ' ' + (v.LastName || '')).trim();
  // Staffing tab only: with "Hide last names" on, show the first name, plus a last initial when two people share it.
  const staffName = (peopleId, full) => {
    if (!state.hideLast) return full;
    const person = state.people.find((x) => x.id === peopleId);
    if (!person) return full.split(' ')[0];
    const twin = state.people.some((x) => x !== person && x.first.toLowerCase() === person.first.toLowerCase());
    return person.first + (twin && person.last ? ' ' + person.last[0] + '.' : '');
  };
  const roleIn = (item, name) => item.roles.find((r) => r.name.toLowerCase() === name.toLowerCase() && !r.admin && !r.inactive);
  const realAssign = (person, evId) => (person.ev[evId] ? person.ev[evId].assign.filter((a) => !a.admin) : []);
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

  // Record which roles of which event a change touched. No role = counts only; null = every role.
  function mark(scope, evId, role) {
    if (!scope.has(evId)) scope.set(evId, new Set());
    if (role === null) scope.set(evId, null);
    else if (role !== undefined && scope.get(evId)) scope.get(evId).add(role.toLowerCase());
  }

  // Refresh after a change. `scope` maps event id to the roles whose people lists need re-reading.
  async function reloadEvents(scope) {
    state.progress = 'Saved in VMS. Refreshing…'; renderHeader();
    try {
      // Several day columns can share one VMS event: combine what each of them needs re-read.
      const groups = new Map();
      state.loaded.forEach((item) => {
        if (!scope.has(item.ev.id)) return;
        const want = scope.get(item.ev.id);
        const cur = groups.get(item.src);
        if (!groups.has(item.src)) groups.set(item.src, want === null ? null : new Set(want));
        else if (cur === null || want === null) groups.set(item.src, null);
        else want.forEach((r) => cur.add(r));
      });
      for (const [src, only] of groups) {
        const fresh = splitDays(await loadEvent(src.ev, () => {}, src, only));
        const at = state.loaded.findIndex((l) => l.src === src);
        state.loaded = state.loaded.filter((l) => l.src !== src);
        state.loaded.splice(at, 0, ...fresh);
      }
      state.people = buildPeople(state.loaded);
    } catch (e) { state.error = e.message; }
    state.progress = ''; renderHeader();
    background();
  }

  // Work left for after the dashboard is usable, done one request at a time:
  // first the quiet roles skipped at load (almost always empty), then the training and last-season reports.
  let working = false;
  let notesShown = true, notesSince = 0;
  let profilesChanged = false, profilesSince = 0;
  const profileFailed = new Set();
  async function background() {
    if (working) return;
    working = true;
    const srcOf = (vmsId) => { const l = state.loaded.find((x) => x.ev.vmsId === vmsId); return l ? l.src : null; };
    const rebuild = (raw) => {
      const at = state.loaded.findIndex((l) => l.src === raw);
      if (at < 0) return;
      state.loaded = state.loaded.filter((l) => l.src !== raw);
      state.loaded.splice(at, 0, ...splitDays(raw));
      state.people = buildPeople(state.loaded);
      state.note = ''; render();
    };
    try {
      for (;;) {
        if (state.busy) break;
        // Someone just opened a details pane: let its requests through first.
        while (paneBusy > 0) await pause(150);
        const q = state.loaded.find((l) => l.src.roles.some((r) => r.unchecked));
        if (q) {
          const vmsId = q.ev.vmsId, role = q.src.roles.find((r) => r.unchecked);
          const left = [...new Set(state.loaded.map((l) => l.src))].reduce((t, raw) => t + raw.roles.filter((r) => r.unchecked).length, 0);
          state.note = 'Checking ' + left + ' quiet role' + (left === 1 ? '' : 's') + '…'; renderHeader();
          const rows = await svc('GetAssignedVolunteers', { eventID: vmsId, roleID: role.id, isCustom: role.custom, viewType: 'Event', day: 0 });
          const cur = srcOf(vmsId);
          const target = cur && cur.roles.find((r) => r.id === role.id && r.custom === role.custom);
          if (target && target.unchecked) {
            target.unchecked = false;
            if (Array.isArray(rows) && rows.length) { target.assigned = rows; rebuild(cur); }
          }
          continue;
        }
        const x = state.loaded.find((l) => l.src.extrasPending);
        if (x) {
          const vmsId = x.ev.vmsId;
          state.note = 'Loading training and last-season details…'; renderHeader();
          let training = new Map(), lastSeason = new Map();
          // Each is a nice-to-have: if one can't be read, carry on without it.
          try { training = await loadTraining(vmsId); } catch (e) { if (Date.now() < blockedUntil) throw e; }
          try { lastSeason = await loadLastSeason(vmsId); } catch (e) { if (Date.now() < blockedUntil) throw e; }
          const cur = srcOf(vmsId);
          if (cur && cur.extrasPending) {
            cur.extrasPending = false; cur.training = training; cur.lastSeason = lastSeason;
            state.loaded.forEach((l) => { if (l.src === cur) { l.training = training; l.lastSeason = lastSeason; } });
            rebuild(cur);
          }
          continue;
        }
        // Last, coordinator comments for everyone loaded, one person at a time.
        const waiting = state.people.filter((p) => !vcNotes.has(p.id));
        if (waiting.length) {
          state.note = 'Checking coordinator comments (' + waiting.length + ' left)…'; renderHeader();
          const id = waiting[0].id;
          let rows = [];
          try { rows = await svc('GetVCComments', { peopleID: id }); } catch (e) { if (Date.now() < blockedUntil) throw e; }
          vcNotes.set(id, coordinatorNotes(rows));
          if (vcNotes.get(id).length) notesShown = false;
          // Show new marks every so often and at the end, but not while someone is typing.
          if (!notesShown && (waiting.length === 1 || ++notesSince >= 25)) {
            notesSince = 0;
            const typing = shadow.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(shadow.activeElement.tagName);
            if (state.tab === 'staff' && !typing && !state.staffApplying) { notesShown = true; renderMain(); }
          }
          continue;
        }
        // Then their profiles: consent first (the role lists can't be trusted for it), then the rest for shirt sizes,
        // pronouns and languages in the roster.
        const unread = state.people.filter((p) => !profiles.has(p.id) && !profileFailed.has(p.id));
        if (unread.length) {
          const next = unread.find((p) => consentOf(p) === 'checking') || unread[0];
          state.note = 'Reading volunteer profiles (' + unread.length + ' left)…'; renderHeader();
          const before = consentOf(next);
          try { await readProfile(next); } catch (e) { if (Date.now() < blockedUntil) throw e; profileFailed.add(next.id); }
          if (consentOf(next) !== before) profilesChanged = true;
          // The headcount's shirt sizes fill in as profiles arrive, while it's open.
          if (state.tab === 'roles' && state.hcOpen && !state.targetEdit && (unread.length === 1 || unread.length % 10 === 0)
            && !(shadow.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(shadow.activeElement.tagName))) renderMain();
          // Redraw now and then so corrected consent flags show, but not while someone is typing.
          if (profilesChanged && (unread.length === 1 || ++profilesSince >= 15)) {
            profilesSince = 0;
            const typing = shadow.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(shadow.activeElement.tagName);
            if (!typing && !state.staffApplying && !state.drafting) {
              profilesChanged = false;
              state.people = buildPeople(state.loaded);
              render();
            }
          }
          continue;
        }
        break;
      }
    } catch (e) {
      state.error = 'Could not finish loading the remaining details (' + e.message + '). Press Refresh to try again.';
      working = false; state.note = ''; render();
      return;
    }
    working = false;
    state.note = ''; renderHeader();
  }

  // ----- Hiding applicants (Staffing tab) -----
  // Hiding only takes someone out of the applicant lists; VMS tells the volunteer nothing, and it can be undone.

  const hideCall = (vmsId, roleId, people, hide) => svcPost('HideUnhideVolunteer', { eventID: vmsId, peopleRoleID: roleId, people: String(people), hide });
  const readHidden = (raw, role) => svc('GetUnassignedVolunteers', { eventID: raw.ev.id, roleID: role.id, tab: 'Hidden', isCustom: role.custom });
  const readApplicants = (raw, role) => svc('GetUnassignedVolunteers', { eventID: raw.ev.id, roleID: role.id, tab: 'Applicants', isCustom: role.custom });
  // Who is hidden from the whole event: anyone on two different roles' Hidden lists.
  async function readEventHidden(raw) {
    const probes = raw.roles.filter((r) => !r.admin).slice(0, 2);
    if (probes.length < 2) return;
    const lists = await Promise.all(probes.map((r) => readHidden(raw, r)));
    const both = new Set(lists[1].map((v) => v.PeopleID));
    raw.eventHidden = lists[0].filter((v) => both.has(v.PeopleID));
  }
  function redrawAfterHide(raws) {
    raws.forEach((raw) => {
      const at = state.loaded.findIndex((l) => l.src === raw);
      if (at < 0) return;
      state.loaded = state.loaded.filter((l) => l.src !== raw);
      state.loaded.splice(at, 0, ...splitDays(raw));
    });
    state.people = buildPeople(state.loaded);
    state.hiding = false; state.hideAsk = null;
    render();
  }

  // scope: 'role' hides from the named role only, 'all' from every role of the event.
  async function hidePerson(person, roleName, scope) {
    state.hiding = true; renderMain();
    const raws = [...new Set(state.loaded.filter((l) => person.ev[l.ev.id]).map((l) => l.src))];
    const failed = [];
    for (const raw of raws) {
      const role = raw.roles.find((r) => r.name.toLowerCase() === roleName.toLowerCase() && !r.admin);
      try {
        if (scope === 'role') {
          if (!role) continue;
          await hideCall(raw.ev.id, role.id, person.id, true);
          role.applicants = (Array.isArray(role.applicants) ? role.applicants : []).filter((v) => v.PeopleID !== person.id);
          if (role.counts) role.counts.applicants = Math.max(0, role.counts.applicants - 1);
          role.hidden = await readHidden(raw, role);
          const all = new Set((raw.eventHidden || []).map((v) => v.PeopleID));
          role.hidden = role.hidden.filter((v) => !all.has(v.PeopleID));
        } else {
          await hideCall(raw.ev.id, 0, person.id, true);
          raw.roles.forEach((r) => {
            const had = Array.isArray(r.applicants) && r.applicants.some((v) => v.PeopleID === person.id);
            if (had) { r.applicants = r.applicants.filter((v) => v.PeopleID !== person.id); if (r.counts) r.counts.applicants = Math.max(0, r.counts.applicants - 1); }
            r.hidden = (r.hidden || []).filter((v) => v.PeopleID !== person.id);
          });
          await readEventHidden(raw);
        }
      } catch (e) { failed.push(evShort(raw.ev) + ' (' + e.message + ')'); }
    }
    redrawAfterHide(raws);
    toast(failed.length ? 'Could not hide on ' + failed.join('; ') : person.first + ' is hidden from ' + (scope === 'role' ? roleName : 'all roles') + '.');
  }

  // records: [{ raw, row, scope }] as listed under "Hidden" for the role.
  async function unhidePerson(records, roleName) {
    state.hiding = true; renderMain();
    const failed = [];
    const raws = [...new Set(records.map((x) => x.raw))];
    for (const { raw, row, scope } of records) {
      try {
        await hideCall(raw.ev.id, 0, row.HiddenID, false);
        const key = personKey(row.Email, row.LastName, row.FirstName);
        // Back in the applicant list of this role, or of every role they applied for.
        const names = scope === 'role' ? [roleName.toLowerCase()]
          : [...new Set((raw.apps || []).filter((x) => x.open && x.key === key).map((x) => x.role))];
        if (scope === 'all') await readEventHidden(raw);
        const all = new Set((raw.eventHidden || []).map((v) => v.PeopleID));
        for (const role of raw.roles.filter((r) => !r.admin && names.includes(r.name.toLowerCase()))) {
          role.applicants = await readApplicants(raw, role);
          if (role.counts) role.counts.applicants = role.applicants.length;
          if (scope === 'role') role.hidden = (await readHidden(raw, role)).filter((v) => !all.has(v.PeopleID));
        }
      } catch (e) { failed.push(evShort(raw.ev) + ' (' + e.message + ')'); }
    }
    redrawAfterHide(raws);
    toast(failed.length ? 'Could not unhide on ' + failed.join('; ') : 'Unhidden.');
  }

  function resultBox(result, okText, tail) {
    if (!result) return null;
    return h('div', { class: 'msg' + (result.failed.length ? ' err' : '') },
      okText(result.ok) + (result.failed.length ? ' ' + result.failed.length + ' failed: ' + result.failed.join('; ') + '.' : '')
      + (result.ok && tail ? ' ' + tail : ''));
  }

  // ----- Volunteer detail panel -----

  function profileUrl(person) {
    const key = Object.keys(person.ev)[0];
    const evId = vmsEventOf(key);
    const e = person.ev[key];
    const r = e.assign[0] || e.applied[0] || {};
    return '/VMS/Volunteers/VolunteerDetails.aspx?ID=' + evId + '&RoleID=' + (r.roleId || 0)
      + '&IsCustom=' + (r.custom ? 'True' : 'False') + '&PeopleID=' + person.id;
  }
  // A plain click opens the details pane. The link itself is their VMS profile, so a middle-click, Ctrl/Cmd-click
  // or "Open link in new tab" opens that in a new tab.
  const paneClick = (id) => (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openDetail(id, e.currentTarget);
  };
  const profileHref = (id) => { const p = state.people.find((x) => x.id === id); return p ? profileUrl(p) : '#'; };
  const nameLink = (person, text) => h('a', {
    class: 'pname', href: profileUrl(person), title: 'Show details (middle-click for their VMS profile)', 'data-pid': person.id,
    onclick: paneClick(person.id),
  }, text || person.first + ' ' + person.last);

  function openDetail(id, from) {
    const person = state.people.find((x) => x.id === id);
    if (!person) return;
    if (from) {
      const ids = [];
      mainEl.querySelectorAll('a.pname[data-pid]').forEach((a) => { const n = Number(a.dataset.pid); if (!ids.includes(n)) ids.push(n); });
      state.detailList = ids.includes(id) ? ids : [id];
    } else if (!(state.detailList || []).includes(id)) state.detailList = [id];
    state.detail = { id, extra: {} };
    renderPanel();
    const set = (key, value) => {
      if (!state.detail || state.detail.id !== id) return;
      state.detail.extra[key] = value;
      renderPanel();
    };
    const evId = vmsEventOf(Object.keys(person.ev)[0]);
    // These go ahead of the background work, which also pauses until they're in (see background()).
    const want = (key, promise) => {
      paneBusy++;
      return promise.then((v) => set(key, v), () => set(key, null)).finally(() => { paneBusy--; });
    };
    want('season', svc('GetVolunteerAssignments', { peopleID: id, isCurrentSeason: true }, true));
    want('history', svc('GetVolunteerAssignments', { peopleID: id, isCurrentSeason: false }, true));
    want('others', svc('GetVolunteerApplications', { peopleID: id, eventID: evId, excludeEvent: true }, true));
    want('comments', svc('GetVCComments', { peopleID: id }, true).then((rows) => { vcNotes.set(id, coordinatorNotes(rows)); return rows; }));
    want('profile', profiles.has(id) ? Promise.resolve(profiles.get(id)) : readProfile(person));
  }
  // A volunteer's VMS profile page: what VMS shows about them. The role lists VMS+ loads from carry some of the same
  // details, but they're often blank or out of date there (consent most of all), so these come from the profile.
  const profiles = new Map();
  const PROFILE_LABELS = ['Legal First Name', 'Phone', 'Email', 'Address', 'Demographics', 'Age', 'Service', 'Gender', 'Shirt', 'Pronouns',
    'Languages Spoken', 'Self-Reported Accommodations', 'Dietary Restrictions', 'Emergency Contact', 'Contact Name', 'Phone Number', 'Alumni',
    'Skills/Expertise in', 'Team Affiliation', 'Affiliations', 'Employer', 'Share With Employer', 'FIRST Youth Protection Policy',
    'Local Youth Protection Requirements', 'FIRST Overall Pennsylvania YPP Clearance Status', 'FIRST Overall California YPP Clearance Status',
    'Consent & Release'];
  function parseProfile(doc) {
    const pick = (name) => txt(doc.getElementById('MainContent_' + name));
    // Split an element's text into lines wherever the page breaks it visually.
    const lines = (name) => {
      const out = [];
      let cur = '';
      const flush = () => { const t = cur.replace(/\s+/g, ' ').trim(); if (t) out.push(t); cur = ''; };
      const walk = (node) => {
        if (node.nodeType === 3) { cur += node.nodeValue; return; }
        if (node.nodeType !== 1) return;
        const block = /^(BR|LI|DIV|P|TR|UL|OL|TABLE)$/.test(node.tagName);
        if (block) flush();
        node.childNodes.forEach(walk);
        if (block) flush();
      };
      const el = doc.getElementById('MainContent_' + name);
      if (el) { walk(el); flush(); }
      return out;
    };
    // The top of the page is "Label: value" pairs; status icons say what they mean in their tooltip.
    const html = doc.body ? doc.body.innerHTML : '';
    const from = html.search(/Legal First Name/), to = html.search(/MainContent_CoursesSectionDiv/);
    const text = (from >= 0 ? html.slice(from, to > from ? to : from + 20000) : '')
      .replace(/<span[^>]*title=['"]([^'"]*)['"][^>]*>\s*<\/span>/g, ' $1 ').replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
    const field = {};
    const re = new RegExp('(' + PROFILE_LABELS.map((l) => l.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).sort((x, y) => y.length - x.length).join('|') + '):', 'g');
    const marks = [];
    let m;
    while ((m = re.exec(text))) marks.push([m[1], m.index, re.lastIndex]);
    marks.forEach(([label, , end], i) => { field[label] = text.slice(end, i + 1 < marks.length ? marks[i + 1][1] : text.length).trim(); });
    const value = (label) => { const t = (field[label] || '').trim(); return /^-?$/.test(t) ? '' : t; };
    return {
      dietary: pick('DietaryRestrictionsLabel'), limits: pick('PhysicalLimitationsLabel'),
      emergency: [pick('EmergencyContactLabel'), pick('EmergencyContactNumberLabel')].filter(Boolean).join(' · '),
      skills: pick('skillsLabel'), teams: lines('team_affiliationLabel'), orgs: pick('person_affiliation'),
      courses: lines('CourseListDiv'),
      consent: value('Consent & Release'), shirt: value('Shirt'), pronouns: value('Pronouns'), languages: value('Languages Spoken'),
      alumni: /^yes/i.test(value('Alumni')), employer: value('Employer'),
    };
  }
  async function readProfile(person) {
    const { doc } = await fetchDoc(profileUrl(person));
    const pr = parseProfile(doc);
    profiles.set(person.id, pr);
    return pr;
  }
  // Whether they've signed this season's Consent and Release form: the profile's answer when it has been read.
  // The role lists often still say "Unsigned" after someone has signed, so that alone is never treated as unsigned.
  const consentOf = (p) => {
    const pr = profiles.get(p.id);
    if (pr && pr.consent) return /^signed/i.test(pr.consent) ? 'signed' : 'unsigned';
    return /^signed/i.test(p.raw.SignedConsentReleaseStatus || '') ? 'signed' : 'checking';
  };
  // The pane slides in and out a little (140ms); with reduced motion it just appears and disappears.
  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Previous / next person in the list the pane was opened from (also the ← and → keys).
  function stepDetail(by) {
    const list = state.detailList || [];
    const at = state.detail ? list.indexOf(state.detail.id) : -1;
    const next = list[at + by];
    if (at < 0 || next == null) return;
    // Keep the pane where it is: no slide when moving between people.
    openDetail(next);
  }
  function closeDetail() {
    if (!state.detail) return;
    if (panelEl.hidden || reduceMotion()) { state.detail = null; renderPanel(); return; }
    const closing = state.detail;
    panelEl.classList.add('away');
    setTimeout(() => {
      panelEl.classList.remove('away');
      // Someone else may have been opened meanwhile; then leave that pane open.
      if (state.detail === closing) { state.detail = null; renderPanel(); }
    }, 140);
  }
  // Esc closes the details pane wherever the keyboard focus is, inside the dashboard or on the VMS page behind it.
  document.addEventListener('keydown', (e) => {
    if (!state.detail || root.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeDetail(); return; }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const t = e.composedPath()[0];
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      e.preventDefault();
      stepDetail(e.key === 'ArrowLeft' ? -1 : 1);
    }
  }, true);

  function renderPanel() {
    const person = state.detail && state.people.find((x) => x.id === state.detail.id);
    const opening = panelEl.hidden && !!person;
    panelEl.hidden = !person;
    if (person) placePanel();
    if (opening && !reduceMotion()) {
      // Jump to the starting position without animating, make the browser apply it, then slide in from there.
      panelEl.classList.add('away', 'instant');
      void panelEl.offsetWidth;
      panelEl.classList.remove('instant');
      void panelEl.offsetWidth;
      panelEl.classList.remove('away');
    }
    panelEl.replaceChildren();
    if (!person) { state.detail = null; return; }
    const v = person.raw || {};
    const x = state.detail.extra;
    const blank = (t) => !t || /^(none|n\/a|not specified|no|-)$/i.test(String(t).trim());
    const kv = (pairs) => {
      const shown = pairs.filter(([, val]) => val != null && val !== '' && val !== false);
      return shown.length ? h('dl', { class: 'kv' }, shown.map(([k, val]) => [h('dt', {}, k), h('dd', {}, val)])) : h('div', { class: 'sub' }, 'Nothing recorded.');
    };
    const list = (items, limit) => (items.length
      ? h('ul', {}, items.slice(0, limit).map((t) => h('li', {}, t)), items.length > limit ? h('li', { class: 'muted' }, 'and ' + (items.length - limit) + ' more') : null)
      : h('div', { class: 'sub' }, 'None.'));
    // undefined = still loading, null = the request failed.
    const lazy = (value, build) => (value === undefined ? h('div', { class: 'sub' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), 'Loading…')
      : value === null ? h('div', { class: 'sub' }, 'Could not load this from VMS.') : build(value));
    const loadedIds = new Set(state.loaded.map((l) => l.ev.vmsId));
    // A screening status as a short colored chip; VMS's own wording is in the tooltip.
    const clearanceChip = (text, cleared) => {
      const t = String(text || '');
      if (cleared === true || /^meets/i.test(t)) return chip('ok', 'Cleared', t);
      if (/expir/i.test(t)) return chip('bad', 'Expired', t);
      if (/pending|in progress|submitted|processing|review/i.test(t)) return chip('warn', 'In progress', t);
      return chip('bad', 'Not cleared', t);
    };
    // VMS glues the season year onto event names in assignment lists ("Philadelphia Event2026", "Meet 32024");
    // put the space back, using the event's own date to tell which digits are the year.
    const eventName = (r) => {
      const name = String(r.EventName || ''), d = dateOf(r.EventDateDisplay || r.EventStartDateDisplay);
      if (!d) return name;
      for (const y of [d.getFullYear(), d.getFullYear() - 1, d.getFullYear() + 1]) {
        const ys = String(y);
        if (name.length > 4 && name.endsWith(ys) && !/\s/.test(name[name.length - 5])) return name.slice(0, -4) + ' ' + ys;
      }
      return name;
    };
    // Past assignments grouped by role: one line per role with how often and when, each opening to its events.
    const opened = state.detail.openRoles || (state.detail.openRoles = new Set());
    const roleHistory = (rows, season) => {
      // VMS also lists this season's events as previous ones; those are already shown above.
      // FIRST seasons start in August, so anything dated since August 1 belongs to this season.
      const today = new Date();
      const seasonStart = new Date(today.getMonth() >= 7 ? today.getFullYear() : today.getFullYear() - 1, 7, 1);
      const now = new Set(season.map((r) => r.EventDateDisplay + '|' + r.RoleName));
      const past = rows.filter((r) => r.RoleName && !now.has(r.EventDateDisplay + '|' + r.RoleName)
        && !((dateOf(r.EventDateDisplay) || 0) >= seasonStart));
      if (!past.length) return h('div', { class: 'sub' }, 'None.');
      const when = (r) => { const d = dateOf(r.EventDateDisplay); return d ? d.getTime() : 0; };
      const groups = new Map();
      past.forEach((r) => {
        const k = r.RoleName.trim().toLowerCase();
        if (!groups.has(k)) groups.set(k, { name: r.RoleName.trim(), rows: [] });
        groups.get(k).rows.push(r);
      });
      const list = [...groups.values()].map((g) => {
        g.rows.sort((a, b) => when(b) - when(a));
        const years = g.rows.map((r) => (dateOf(r.EventDateDisplay) || { getFullYear: () => 0 }).getFullYear()).filter(Boolean);
        g.first = Math.min(...years); g.last = Math.max(...years);
        return g;
      }).sort((a, b) => b.rows.length - a.rows.length || when(b.rows[0]) - when(a.rows[0]));
      const firstYear = Math.min(...list.map((g) => g.first).filter((y) => isFinite(y) && y > 0));
      const SHOWN = 8;
      const row = (g) => h('details', { class: 'hist', open: opened.has(g.name),
        ontoggle: (e) => { if (e.target.open) opened.add(g.name); else opened.delete(g.name); } },
        h('summary', {}, h('span', { class: 'hrole' }, g.name),
          h('span', { class: 'hmeta hcount' }, plural(g.rows.length, 'time')),
          h('span', { class: 'hmeta' }, !isFinite(g.first) ? '' : g.first === g.last ? String(g.first) : g.first + '–' + g.last)),
        h('ul', {}, g.rows.map((r) => h('li', {}, [r.EventDateDisplay, eventName(r)].filter(Boolean).join(' · ')))));
      const more = list.length - SHOWN;
      return h('div', {},
        h('div', { class: 'sub', style: 'margin-bottom:4px' }, plural(past.length, 'assignment') + ' in ' + plural(list.length, 'role')
          + (isFinite(firstYear) ? ' · volunteering since ' + firstYear : '')),
        list.slice(0, SHOWN).map(row),
        more > 0 ? h('details', { class: 'hist hmore', open: opened.has('*more'),
          ontoggle: (e) => { if (e.target.open) opened.add('*more'); else opened.delete('*more'); } },
          h('summary', {}, h('span', { class: 'hrole muted' }, plural(more, 'more role'))), list.slice(SHOWN).map(row)) : null);
    };
    // This season grouped by role, each role opening to its events and their status. Roles they're doing or applying
    // for at the loaded events start open.
    const seasonByRole = (rows) => {
      if (!rows.length) return h('div', { class: 'sub' }, 'None.');
      const groups = new Map();
      rows.forEach((r) => { const k = String(r.RoleName || '').trim(); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
      const isOpen = (name) => (myRoles.has(cleanRole(name).toLowerCase()) ? !opened.has('*nowc' + name) : opened.has('*now' + name));
      const setOpen = (name, open) => {
        opened.delete('*now' + name); opened.delete('*nowc' + name);
        if (myRoles.has(cleanRole(name).toLowerCase())) { if (!open) opened.add('*nowc' + name); } else if (open) opened.add('*now' + name);
      };
      return h('div', {}, [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([name, rs]) => h('details', { class: 'hist', open: isOpen(name),
        ontoggle: (e) => setOpen(name, e.target.open) },
        h('summary', {}, h('span', { class: 'hrole' }, name), h('span', { class: 'hmeta hcount' }, plural(rs.length, 'time')), h('span', { class: 'hmeta' }, '')),
        h('ul', {}, rs.map((r) => h('li', {}, [r.EventDateDisplay, eventName(r), r.AssignmentStatus].filter(Boolean).join(' · ')))))));
    };

    // Training for one event: each course once, what still needs doing first; done and optional courses fold away.
    const trainingBlock = (items, key) => {
      const byName = new Map();
      items.forEach((t) => {
        const k = String(t.course || '').trim().toLowerCase();
        if (!k) return;
        const cur = byName.get(k) || { course: String(t.course).trim(), done: false, required: false };
        cur.done = cur.done || !!t.done; cur.required = cur.required || !!t.required;
        byName.set(k, cur);
      });
      const all = [...byName.values()].sort((a, b) => a.course.localeCompare(b.course));
      const todo = all.filter((t) => !t.done && t.required), done = all.filter((t) => t.done), optional = all.filter((t) => !t.done && !t.required);
      const row = (t, status) => h('div', { class: 'trow' }, h('span', {}, t.course), status);
      // Folded lists need no status on each row: the heading says it.
      const fold = (id, label, list) => (list.length ? h('details', { class: 'tfold', open: opened.has(key + id),
        ontoggle: (e) => { if (e.target.open) opened.add(key + id); else opened.delete(key + id); } },
        h('summary', {}, label), list.map((t) => row(t, null))) : null);
      return h('div', { class: 'tlist' },
        todo.map((t) => row(t, chip('warn', 'Required'))),
        !todo.length ? h('div', { class: 'trow' }, h('span', { class: 'tok' }, done.length ? 'All required training done' : 'No required training')) : null,
        fold(':done', plural(done.length, 'course') + ' done', done),
        fold(':opt', plural(optional.length, 'optional course') + ' not done', optional));
    };
    // The roles they're doing or applying for at the loaded events, and those roles' courses: used to show what's
    // relevant first.
    const myRoles = new Set();
    const roleCourses = new Set();
    state.loaded.forEach((l) => {
      const e = person.ev[l.ev.id];
      if (!e) return;
      [...e.assign, ...e.applied].forEach((a) => { const r = cleanRole(a.role).toLowerCase(); if (r && r !== 'assign me as needed') myRoles.add(r); });
      (e.training || []).forEach((t) => { if (myRoles.has(cleanRole(t.role || '').toLowerCase())) roleCourses.add(String(t.course || '').trim().toLowerCase()); });
    });
    // Each assignment on two lines: the role, then a smaller line with its time and whether VMS has emailed them.
    // Long role names never push the status onto a line of its own.
    const assignedLine = (e) => {
      if (!e.assign.length) return 'Not assigned';
      return e.assign.map((a) => h('div', { class: 'arow' }, h('div', {}, a.role),
        a.shifts.length ? h('div', { class: 'sub' }, a.shifts.map((sh, i) => [i ? ' · ' : '', sh.time, ' · ',
          sh.notified ? h('span', { class: 'tok' }, 'Notified') : h('span', { class: 'twarn' }, 'Not notified')]))
          : !a.admin ? h('div', { class: 'sub' }, h('span', { class: 'twarn' }, 'No shift set')) : null));
    };
    const appliedLine = (e) => (e.applied.length ? e.applied.slice().sort((a, b) => String(a.pref).localeCompare(String(b.pref), undefined, { numeric: true }))
      .map((a) => h('div', {}, (a.pref ? '#' + a.pref + ' ' : '') + a.role + (a.times ? ' (done ' + a.times + (a.times === 1 ? ' time' : ' times') + ')' : ''))) : null);
    // One block per event. A multi-day event gets a line per day for what they're doing there, then the
    // event-wide details (applications, availability, training) once. Training is for the event days: someone on a
    // setup day is setting up, so their role's training doesn't apply to it.
    const perEvent = (() => {
      const cols = state.loaded.filter((l) => person.ev[l.ev.id]);
      return [...new Set(cols.map((l) => l.ev.vmsId))].map((id) => {
        const mine = cols.filter((l) => l.ev.vmsId === id);
        const main = mine.find((l) => !l.ev.setup) || mine[0];
        const e = person.ev[main.ev.id];
        // VMS lists an application only on days they aren't assigned yet, so take it from whichever day has it,
        // leaving out roles they already hold on another day of this event.
        const held = new Set(mine.flatMap((l) => person.ev[l.ev.id].assign.map((a) => cleanRole(a.role).toLowerCase())));
        const from = mine.map((l) => person.ev[l.ev.id]).find((d) => d.applied.length) || e;
        const applied = { ...from, applied: from.applied.filter((a) => !held.has(cleanRole(a.role).toLowerCase())) };
        const rec = (e.recs[0] || {}).v || {};
        const comments = [...new Set(mine.flatMap((l) => person.ev[l.ev.id].recs.map((r) => r.v.Comments)).filter((t) => !blank(t)))];
        return [h('h3', {}, mine.length > 1 ? main.ev.name : evLabel(main.ev)), kv([
          ...(mine.length > 1 ? mine.map((l) => [evShort(l.ev), assignedLine(person.ev[l.ev.id])]) : [['Assigned', assignedLine(e)]]),
          ['Applied for', appliedLine(applied)],
          ['Applied on', applied.appliedOn ? new Date(applied.appliedOn).toLocaleDateString() : null],
          ['Days available', rec.DaysAvailable],
          ['Last season here', e.lastSeason || null],
          ['Training', e.training && e.training.length && !main.ev.setup ? trainingBlock(e.training, 'tr' + id) : null],
          ['Their comment', comments.length ? comments.map((t) => h('div', {}, t)) : null],
        ])];
      });
    })();

    // About and their VMS profile together as one "Profile" section; left out entirely when there's nothing in it.
    // The page-based details (teams, skills, courses…) arrive a moment later than the rest.
    const profilePairs = (pr) => [
      // The same number VMS shows in its role pages' "FIRST Years of Service" column.
      ['FIRST years of service', v.InFIRST ? String(v.InFIRST) : null],
      ['FIRST alumni', pr && pr.alumni ? 'Yes' : null],
      ['Employer', !pr || blank(pr.employer) ? null : pr.employer],
      ['Affiliations', !pr || blank(pr.orgs) || /no affiliation/i.test(pr.orgs) ? null : pr.orgs],
      ['Team affiliations', !pr ? null : (() => {
        const teams = pr.teams.filter((n) => !blank(n) && !/no affiliation/i.test(n));
        // VMS writes "FRC Team# 321 RoboLancers"; show it as "FRC 321 RoboLancers".
        return teams.length ? teams.map((n) => h('div', {}, n.replace(/^\s*(FRC|FTC|FLL)\s+Team\s*#\s*/i, (m, prog) => prog.toUpperCase() + ' '))) : null;
      })()],
      ['Skills', !pr || blank(pr.skills) ? null : pr.skills],
      ['Shirt size', !pr || blank(pr.shirt) ? null : pr.shirt],
      ['Dietary', !pr || blank(pr.dietary) ? null : pr.dietary],
      ['Accommodations', !pr || blank(pr.limits) ? null : pr.limits],
      ['Emergency contact', pr ? pr.emergency : null],
      ['Training completed', !pr ? null : (() => {
        // A finished training path (Mentor Ready, Volunteer Ready) is listed twice: the path itself and a
        // "… Training Path Completion" entry. The second adds nothing when the first is there.
        const named = (t) => t.replace(/^[\d/\s-]*-\s*/, '').trim().toLowerCase();
        const have = new Set(pr.courses.map(named));
        const shown = pr.courses.filter((t) => {
          const m = /^(.*?)\s+training path completion$/i.exec(named(t));
          return !(m && have.has(m[1]));
        });
        if (!shown.length) return null;
        // Courses for the roles they're doing or applying for at the loaded events stay in view; the rest fold away.
        const related = shown.filter((t) => {
          const c = named(t);
          return roleCourses.has(c) || [...myRoles].some((r) => r.length > 2 && new RegExp('\\b' + r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(c));
        });
        const rest = shown.filter((t) => !related.includes(t));
        const fold = (label, items) => h('details', { class: 'tfold tlist', open: opened.has('*courses'),
          ontoggle: (e) => { if (e.target.open) opened.add('*courses'); else opened.delete('*courses'); } },
          h('summary', {}, label), items.map((t) => h('div', {}, t)));
        return [related.map((t) => h('div', {}, t)),
          rest.length ? fold(related.length ? plural(rest.length, 'other course') : plural(rest.length, 'course') + ' completed', rest) : null];
      })()],
    ];
    const profileSection = () => {
      const pr = x.profile || null;
      const pairs = profilePairs(pr).filter(([, val]) => val != null && val !== '' && val !== false);
      const tail = x.profile === undefined ? h('div', { class: 'sub' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), 'Loading the rest of their profile…')
        : x.profile === null ? h('div', { class: 'sub' }, 'Could not load the rest of their profile from VMS.') : null;
      if (!pairs.length && !tail) return '';
      return h('div', {}, h('h3', {}, 'Profile'), pairs.length ? kv(pairs) : null, tail);
    };
    panelEl.append(
      h('div', { class: 'bar' },
        h('h2', { class: 'grow' }, person.first + ' ' + person.last,
          // Coordinator comments are listed at the bottom. The same speech bubble as on Staffing, next to the name,
          // says they're there: hovering shows them, clicking jumps to them.
          Array.isArray(x.comments) && coordinatorNotes(x.comments).length ? h('span', { class: 'vcnote notejump', role: 'button', tabindex: 0,
            title: 'Coordinator comments (click to jump to them):\n\n' + noteText(coordinatorNotes(x.comments)),
            'aria-label': 'Has coordinator comments', onclick: () => {
              const target = [...panelEl.querySelectorAll('h3')].find((el) => el.textContent === 'Coordinator comments');
              if (target) panelEl.scrollTop = target.offsetTop - 8;
            } }) : null),
        (() => {
          const list = state.detailList || [], at = list.indexOf(person.id);
          if (list.length < 2 || at < 0) return null;
          return h('span', { class: 'panenav' },
            h('button', { class: 'xbtn', title: 'Previous person (\u2190)', 'aria-label': 'Previous person', disabled: at === 0, onclick: () => stepDetail(-1) }, '\u2039'),
            h('span', { class: 'muted' }, (at + 1) + ' of ' + list.length),
            h('button', { class: 'xbtn', title: 'Next person (\u2192)', 'aria-label': 'Next person', disabled: at === list.length - 1, onclick: () => stepDetail(1) }, '\u203a'));
        })(),
        h('button', { class: 'xbtn paneclose', onclick: closeDetail, title: 'Close (Esc)', 'aria-label': 'Close this volunteer' }, '×')),
      person.flags.length ? h('div', {}, person.flags.map((f) => chip(FLAG_TONE[f], FLAG_LABEL[f], f === 'clearance' ? person.clearance : ''))) : '',
      h('div', {}, perEvent),
      h('h3', {}, 'Contact'),
      kv([
        ['Email', person.email ? h('a', { href: 'mailto:' + person.email, title: 'Write to them',
          onclick: (e) => { e.preventDefault(); withMailer(() => openEmail({ to: person.email })); } }, person.email) : null],
        ['Phone', /^\d{10}$/.test(v.PhoneNumber || '') ? v.PhoneNumber.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3') : v.PhoneNumber],
        ['Location', [v.City, v.State].filter(Boolean).join(', ')],
        ['Age', person.age != null ? person.age + (person.age < 18 ? ' (minor)' : '') : null],
        ['Pronouns', x.profile && !blank(x.profile.pronouns) ? x.profile.pronouns : null],
        ['Languages', x.profile && !blank(x.profile.languages) ? x.profile.languages : null],
      ]),
      h('h3', {}, 'Clearance and paperwork'),
      kv([
        ['Youth protection', clearanceChip(person.clearance || (person.cleared ? 'Meets requirements' : 'Not cleared'), person.cleared)],
        ['Pennsylvania', blank(v.YPPStatusPA) || /no known roles/i.test(v.YPPStatusPA) ? null : clearanceChip(v.YPPStatusPA)],
        ['California', blank(v.YPPStatusCA) || /no known roles/i.test(v.YPPStatusCA) ? null : clearanceChip(v.YPPStatusCA)],
        ['Consent and release', (() => {
          const c = consentOf(person);
          return c === 'signed' ? chip('ok', 'Signed', 'From their VMS profile') : c === 'unsigned' ? chip('warn', 'Not signed', 'From their VMS profile')
            : h('span', { class: 'sub' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), 'Checking their profile…');
        })()],
      ]),
      profileSection(),
      h('h3', {}, 'All assignments this season'),
      lazy(x.season, seasonByRole),
      h('h3', {}, 'Applied to other events'),
      lazy(x.others, (rows) => list([...new Set(rows.filter((r) => !loadedIds.has(r.EventID))
        .map((r) => [r.EventStartDateDisplay, eventName(r)].filter(Boolean).join(' · ')))], 12)),
      h('h3', {}, 'Previous seasons'),
      lazy(x.history, (rows) => roleHistory(rows, Array.isArray(x.season) ? x.season : [])),
      h('h3', {}, 'Coordinator comments'),
      lazy(x.comments, (rows) => list(coordinatorNotes(rows).map((r) => (r.postedDate ? noteDate(r.postedDate) + ': ' : '') + r.note.trim()), 20)),
      !Array.isArray(x.comments) ? '' : lazy(x.comments, (rows) => {
        const support = usableNotes(rows).filter(isSupportNote);
        if (!support.length) return null;
        const flat = (t) => t.replace(/\s+/g, ' ').trim();
        return h('details', { class: 'hist hmore support', open: opened.has('*support'),
          ontoggle: (e) => { if (e.target.open) opened.add('*support'); else opened.delete('*support'); } },
          h('summary', {}, h('span', { class: 'hrole muted', title: 'Case notes, emails and chats that FIRST\'s support team copies into VMS' },
            'FIRST support history (' + support.length + ')')),
          support.map((r, i) => h('details', { class: 'snote', open: opened.has('*s' + i),
            ontoggle: (e) => { if (e.target.open) opened.add('*s' + i); else opened.delete('*s' + i); } },
            h('summary', {}, h('span', { class: 'sdate' }, noteDate(r.postedDate)), h('span', { class: 'stext' }, flat(r.note))),
            h('div', { class: 'sfull' }, r.note.trim()))));
      }),
      h('div', { style: 'margin-top:18px' },
        h('a', { href: profileUrl(person), target: '_blank' }, 'Open full profile in VMS')));
  }

  // ----- Staffing tab -----

  function staffView() {
    const loaded = state.loaded;
    let names = [...new Map(loaded.flatMap((l) => l.roles.filter((r) => !r.admin && !r.inactive)
      .map((r) => [r.name.toLowerCase(), { name: r.name, key: r.key }]))).values()]
      .sort((a, b) => (b.key - a.key) || a.name.localeCompare(b.name));
    const allRoleCount = names.length;
    if (state.hideZero) {
      names = names.filter((n) => loaded.some((l) => {
        const r = roleIn(l, n.name);
        return r && ((r.counts && r.counts.target > 0) || r.assigned.length > 0 || r.applicants.some((v) => !v.otherDay)
          || state.staged.some((x) => x.evId === l.ev.id && x.role === n.name));
      }));
    }
    if (!names.some((n) => n.name === state.staffRole)) state.staffRole = names.length ? names[0].name : '';
    const cur = state.staffRole;
    const busy = state.staffApplying;
    const stagedFor = (evId, role) => state.staged.filter((x) => !x.remove && x.evId === evId && x.role === role);
    const removalOf = (evId, role, peopleId) => state.staged.find((x) => x.remove && x.evId === evId && x.role === role && x.peopleId === peopleId);
    const sameRole = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase();
    const fill = (l, name) => {
      const r = roleIn(l, name);
      if (!r) return null;
      const leaving = state.staged.filter((x) => x.remove && x.evId === l.ev.id && x.role === name).length;
      return { r, have: r.assigned.length - leaving + stagedFor(l.ev.id, name).length, target: r.counts && !l.ev.setup ? r.counts.target : null }; // the target is for event days, not setup days
    };

    // A small badge with the role's minimum age. Its colour shows the age band; it turns red when
    // someone assigned or staged is younger than the minimum on that day.
    const placedIds = (l, name) => {
      const r = roleIn(l, name);
      return [...(r ? r.assigned.filter((v) => !removalOf(l.ev.id, name, v.PeopleID)).map((v) => v.PeopleID) : []),
        ...stagedFor(l.ev.id, name).map((x) => x.peopleId)];
    };
    const ageBadge = (name) => {
      const per = loaded.filter((l) => roleIn(l, name)).map((l) => ({ l, rule: ageRule(name, l.ev) })).filter((x) => x.rule);
      if (!per.length) return null;
      const mins = [...new Set(per.map((x) => x.rule.min))].sort((a, b) => a - b);
      const young = per.flatMap((x) => placedIds(x.l, name).map((id) => state.people.find((p) => p.id === id))
        .filter((p) => ageIssue(p, x.rule) === 'under').map((p) => staffName(p.id, p.first + ' ' + p.last) + ' (' + p.age + ', ' + evShort(x.l.ev) + ')'));
      const tone = young.length ? 'bad' : mins[mins.length - 1] >= 21 ? 'warn' : mins[mins.length - 1] >= 18 ? 'info' : 'ok';
      const tip = 'FIRST recommended minimum age: ' + [...new Set(per.map((x) => (per.length > 1 ? evShort(x.l.ev) + ' ' : '') + ageText(x.rule)))].join('; ')
        + (young.length ? '. Under the minimum: ' + [...new Set(young)].join(', ') : '');
      return h('span', { class: 'chip ' + tone + ' agechip', title: tip }, (young.length ? '! ' : '') + mins.join('/') + '+');
    };
    // Every badge is as wide as the longest one in the list, so the role names still line up.
    const badges = new Map(names.map((n) => [n.name, state.showAges ? ageBadge(n.name) : null]));
    const badgeLen = Math.max(0, ...[...badges.values()].filter(Boolean).map((b) => b.textContent.length));
    const badgeWidth = 'width:' + (badgeLen + 2) + 'ch';
    badges.forEach((b) => { if (b) b.style.cssText = badgeWidth; });
    const roleList = h('div', { class: 'card rolelist' },
      h('label', { class: 'rrow', style: 'justify-content:flex-start' }, h('input', {
        type: 'checkbox', checked: state.hideZero,
        onchange: (e) => { state.hideZero = e.target.checked; state.staffConfirm = false; renderMain(); },
      }), 'Hide roles with no target' + (allRoleCount > names.length ? ' (' + (allRoleCount - names.length) + ')' : '')),
      h('label', { class: 'rrow', style: 'justify-content:flex-start', title: 'FIRST\'s recommended minimum age for each role. Red means someone placed is younger.' }, h('input', {
        type: 'checkbox', checked: state.showAges,
        onchange: (e) => { state.showAges = e.target.checked; renderMain(); },
      }), 'Show minimum ages'),
      h('div', { class: 'rrow muted', style: 'cursor:default' }, h('span', {}, 'Role'), h('span', {}, loaded.map((l) => evShort(l.ev)).join(' · '))),
      names.map((n) => h('div', {
        class: 'rrow' + (n.name === cur ? ' on' : ''),
        onclick: () => { state.staffRole = n.name; state.staffConfirm = false; renderMain(); },
      }, h('span', { class: 'rname' }, state.showAges ? badges.get(n.name) || h('span', { class: 'agechip none', style: badgeWidth }) : null, h('span', {}, n.name)),
      h('span', { class: 'cnt' }, loaded.map((l, i) => {
        const f = fill(l, n.name);
        const text = !f ? '—' : f.target == null && l.ev.setup ? String(f.have) : f.have + '/' + (f.target == null ? '?' : f.target);
        // Each count keeps its separator, so a long row only breaks between events.
        return [i ? ' ' : '', h('span', {}, h('span', { class: f && f.target > 0 ? (f.have < f.target ? 'lo' : 'hi') : '' }, text), i < loaded.length - 1 ? ' ·' : '')];
      })))));

    const withRole = loaded.filter((l) => roleIn(l, cur));
    // "Filling" narrows the people list to one day, started by clicking an open slot.
    if (state.fill && (state.fill.role !== cur || !withRole.some((l) => l.ev.id === state.fill.evId))) state.fill = null;

    // One entry per person in this role on any loaded day, holding what they have on each day.
    const entries = new Map();
    const entryFor = (id, last, first) => {
      if (!entries.has(id)) entries.set(id, { id, last, first, cells: withRole.map(() => null), back: false, untrained: false, age: null });
      return entries.get(id);
    };
    // Only the events that have this role get a column.
    const cols = withRole.map((l, i) => {
      const f = fill(l, cur);
      if (!f) return { l, f: null, open: 0 };
      const times = new Map();
      f.r.assigned.forEach((v) => {
        const shifts = v.Assignments || [];
        const person = state.people.find((x) => x.id === v.PeopleID);
        const e = person && person.ev[l.ev.id];
        const en = entryFor(v.PeopleID, v.LastName || '', v.PreferredName || v.FirstName || '');
        if (e && e.lastSeason && e.lastSeason.toLowerCase().includes(cur.toLowerCase())) en.back = true;
        if (e && (e.training || []).some((t) => t.required && !t.done && sameRole(t.role, cur))) en.untrained = true;
        const time = [...new Set(shifts.map((a) => a.ScheduleDisplayTime))].join(', ');
        const gone = removalOf(l.ev.id, cur, v.PeopleID);
        if (time && !gone) times.set(time, (times.get(time) || 0) + 1);
        en.cells[i] = { v, time, count: shifts.length, notified: shifts.some((a) => a.IsNotified), gone };
      });
      stagedFor(l.ev.id, cur).forEach((x) => {
        const person = state.people.find((y) => y.id === x.peopleId);
        const en = entryFor(x.peopleId, person ? person.last : '', person ? person.first : x.name);
        if (!en.cells[i]) en.cells[i] = { staged: x };
      });
      // Anyone placed on this day who is younger than FIRST's recommended age for the role here.
      const rule = ageRule(cur, l.ev);
      entries.forEach((en) => {
        if (!en.cells[i]) return;
        const issue = ageIssue(state.people.find((x) => x.id === en.id), rule);
        if (issue && (!en.age || issue === 'under')) en.age = { issue, rule, age: state.people.find((x) => x.id === en.id).age };
      });
      // The header shows the shift time set for this day and role (what new assignments get). Where none is set,
      // it shows the time most people already have. A cell only shows a time when it differs from the header.
      const top = [...times.entries()].sort((a, b) => b[1] - a[1])[0];
      const want = effectiveTime(l.ev.id, cur);
      const common = want ? vmsRange(want) : (top ? top[0] : '');
      const differ = [...times.entries()].reduce((n, [time, count]) => n + (time !== common ? count : 0), 0);
      return { l, f, common, set: !!want, differ, want, open: f.target != null ? Math.max(0, f.target - f.have) : 0 };
    });
    if (state.fill && !cols.some((c) => c.l.ev.id === state.fill.evId && c.open > 0)) state.fill = null;
    const fillDay = state.fill ? state.fill.evId : null;
    const list = [...entries.values()].sort((a, b) => a.last.localeCompare(b.last) || a.first.localeCompare(b.first));
    const showName = (en) => (state.hideLast ? staffName(en.id, (en.first + ' ' + en.last).trim()) : (en.last ? en.last + ', ' + en.first : en.first));
    const startFill = (l) => { state.fill = { evId: l.ev.id, role: cur }; state.staffConfirm = false; renderMain(); };
    const stopFill = (e) => { if (e) e.stopPropagation(); state.fill = null; renderMain(); };

    const nameCell = (en) => [
      h('a', { class: 'pname', href: profileHref(en.id), title: 'Show details (middle-click for their VMS profile)', 'data-pid': en.id, onclick: paneClick(en.id) }, showName(en)),
      noteMark(en.id),
      en.back ? h('span', { class: 'inf', title: 'Did this role here last season' }, '↺') : null,
      en.untrained ? h('span', { class: 'bd', title: 'Required training not complete' }, '⚠') : null,
      en.age ? h('span', { class: en.age.issue === 'under' ? 'agemark bd' : 'agemark lo',
        title: 'Age ' + en.age.age + '. FIRST recommends ' + ageText(en.age.rule) + ' for this role'
          + (en.age.issue === 'under' ? '. Exceptions need approval from your Program Delivery Partner.' : '') }, String(en.age.age)) : null,
    ];
    // The status, any unusual time, and the remove or undo button for one person on one day. The button is last.
    const cellBits = (en, i) => {
      const c = en.cells[i], col = cols[i];
      if (c.staged) {
        return [h('span', { class: 'inf', title: 'Staged, not saved yet' }, '+'),
          h('button', { class: 'xbtn', title: 'Undo', disabled: busy, onclick: () => {
            state.staged.splice(state.staged.indexOf(c.staged), 1); state.staffConfirm = false; renderMain();
          } }, '×')];
      }
      const odd = c.time && c.time !== col.common ? c.time : '';
      const tip = !c.time ? 'No shift set' : c.time + (c.count > 1 ? ' (' + c.count + ' shifts)' : '') + (c.notified ? ', notified' : ', not notified yet');
      return [
        c.gone ? h('span', { class: 'sub', title: 'Staged for removal' }, 'removing')
          : h('span', { class: c.notified ? 'hi' : 'lo', title: tip }, c.notified ? '✓' : '•'),
        !c.gone && !c.time ? h('span', { class: 'sub lo' }, 'No shift set') : null,
        !c.gone && odd ? h('span', { class: 'sub' + (col.set ? ' lo' : ''), title: col.set ? 'Differs from the shift time set for this role. The Shift times tab can change it.' : '' }, odd) : null,
        h('button', {
          class: 'xbtn', disabled: busy, title: c.gone ? 'Keep in this role' : 'Remove from this role on ' + evShort(col.l.ev),
          onclick: () => {
            if (c.gone) state.staged.splice(state.staged.indexOf(c.gone), 1);
            else state.staged.push({ remove: true, evId: col.l.ev.id, role: cur, peopleId: c.v.PeopleID, name: fullName(c.v), notified: c.notified });
            state.staffConfirm = false; state.staffResult = null; renderMain();
          },
        }, c.gone ? 'undo' : '×'),
      ];
    };
    const headTip = (col) => evLabel(col.l.ev) + (col.f ? '. ' + (col.want ? 'New assignments get ' + vmsRange(col.want) : 'No shift time set: new assignments get 6am–10pm') : '');
    const dayHead = (col) => {
      if (!col.f) return [evShort(col.l.ev), h('small', {}, 'Not at this event')];
      const f = col.f;
      return [evShort(col.l.ev) + ' · ',
        h('span', { class: f.target > 0 ? (f.have < f.target ? 'lo' : 'hi') : '' }, f.target == null && col.l.ev.setup ? String(f.have) : f.have + ' of ' + (f.target == null ? '?' : f.target)),
        h('small', {}, col.set ? ['Shift ' + col.common, col.differ ? h('span', { class: 'lo' }, ' · ' + col.differ + (col.differ === 1 ? ' differs' : ' differ')) : null]
          : col.common === ALL_DAY ? chip('warn', '6am–10pm', 'Still the all-day default')
            : col.common ? 'Most have ' + col.common : 'no shift time set')];
    };
    const openChip = (col, label) => (fillDay === col.l.ev.id
      ? h('div', { class: 'slot pick' }, 'Filling', h('span', { class: 'sp' }), h('button', { class: 'xbtn', title: 'Stop filling', onclick: stopFill }, '×'))
      : h('button', { class: 'slot open', disabled: busy, title: 'Show the people who can fill ' + evShort(col.l.ev), onclick: () => startFill(col.l) }, label));

    // Each day column keeps its width; with many events the table scrolls sideways instead of squeezing out the names.
    const personTable = () => h('div', { class: 'hscroll' }, h('table', { class: 'rt', style: 'min-width:' + (220 + cols.length * 170) + 'px' },
      h('thead', {}, h('tr', {},
        h('th', {}, plural(list.length, 'person').replace('persons', 'people')),
        cols.map((col) => h('th', { class: 'd', title: headTip(col) }, dayHead(col))))),
      h('tbody', {},
        list.map((en) => h('tr', { class: en.cells.every((c) => !c || c.staged) ? 'stagedrow' : '' },
          h('td', {}, nameCell(en)),
          cols.map((col, i) => {
            if (!en.cells[i]) return h('td', { class: 'd muted' }, '—');
            const bits = cellBits(en, i);
            return h('td', { class: 'd' }, h('div', { class: 'cell' }, bits.slice(0, -1), h('span', { class: 'sp' }), bits[bits.length - 1]));
          }))),
        h('tr', { class: 'openrow' },
          h('td', { class: 'muted', style: 'text-align:right' }, 'Open slots'),
          cols.map((col) => h('td', { class: 'd' }, !col.f ? null
            : col.open > 0 ? openChip(col, col.open + ' open')
              : h('span', { class: 'muted' }, col.f.target == null ? '' : col.f.have > col.f.target ? (col.f.have - col.f.target) + ' over' : 'Full')))))));

    // One row per slot. Someone on every day gets one chip across all of them; the rest sit in their own day's column.
    const slotGrid = () => {
      const active = cols.map((col, i) => i).filter((i) => cols[i].f);
      const isWide = (en) => active.length > 1 && active.every((i) => en.cells[i]);
      const wide = list.filter(isWide);
      const singles = cols.map((col, i) => (col.f ? list.filter((en) => en.cells[i] && !isWide(en)) : []));
      const depth = cols.map((col, i) => (col.f ? singles[i].length + col.open : 0));
      const kids = [h('div', {}), cols.map((col) => h('div', { class: 'slothead', title: headTip(col) }, dayHead(col)))];
      wide.forEach((en, n) => {
        kids.push(h('div', { class: 'slotn' }, n + 1),
          h('div', { class: 'slot' + (active.every((i) => en.cells[i].staged) ? ' new' : ''), style: 'grid-column: ' + (active[0] + 2) + ' / ' + (active[active.length - 1] + 3) },
            nameCell(en), h('span', { class: 'sp' }),
            active.map((i) => h('span', { class: 'daymark' }, h('span', { class: 'sub' }, evShort(cols[i].l.ev)), cellBits(en, i)))));
      });
      for (let r = 0; r < Math.max(0, ...depth); r++) {
        kids.push(h('div', { class: 'slotn' }, wide.length + r + 1));
        cols.forEach((col, i) => {
          const en = singles[i][r];
          if (en) kids.push(h('div', { class: 'slot' + (en.cells[i].staged ? ' new' : '') }, nameCell(en), h('span', { class: 'sp' }), cellBits(en, i)));
          else if (col.f && r < depth[i]) kids.push(r === singles[i].length ? openChip(col, 'Open') : h('button', { class: 'slot open', disabled: busy, onclick: () => startFill(col.l) }, 'Open'));
          else kids.push(h('div', {}));
        });
      }
      return h('div', { class: 'hscroll' }, h('div', { class: 'slots', style: 'grid-template-columns: 26px repeat(' + cols.length + ', minmax(160px, 1fr))' }, kids));
    };

    const setMode = (m) => { state.staffMode = m; renderMain(); };
    const ageLine = () => {
      const per = withRole.map((l) => ({ l, rule: ageRule(cur, l.ev) }));
      const known = per.filter((x) => x.rule);
      if (!known.length) {
        return h('div', { class: 'sub', style: 'margin:-2px 0 8px' }, 'FIRST gives no minimum age for this role'
          + (withRole.some((l) => roleIn(l, cur).custom) ? ' (custom role).' : '.'));
      }
      // One line per program, so two days of the same event read as one.
      const lines = new Map();
      known.forEach(({ l, rule }) => {
        const k = rule.prog + '|' + ageText(rule);
        if (!lines.has(k)) lines.set(k, { rule, days: [] });
        lines.get(k).days.push(evShort(l.ev));
      });
      const r0 = known[0].rule;
      return h('div', { class: 'sub', style: 'margin:-2px 0 8px' },
        'Minimum age ',
        [...lines.values()].map(({ rule, days }, i) => [i ? '; ' : '', h('strong', {}, ageText(rule)),
          lines.size > 1 || rule.other ? ' (' + (lines.size > 1 ? days.join(', ') + ', ' : '') + (PROGRAM_NAME[rule.prog] || 'this program') + ')' : '',
          rule.other ? ' — FIRST lists this role for ' + rule.where.replace(/ only$/, '') + ' only' : '']),
        ' · ',
        h('a', { href: r0.url, target: '_blank', rel: 'noopener', title: 'FIRST role description: ' + r0.title }, 'FIRST role page'));
    };
    const roleCard = h('div', { class: 'card' },
      h('div', { class: 'bar' },
        h('h2', { class: 'grow', style: 'margin:0' }, cur),
        h('button', { class: 'seg' + (state.staffMode === 'person' ? ' on' : ''), onclick: () => setMode('person') }, 'By person'),
        h('button', { class: 'seg' + (state.staffMode === 'slot' ? ' on' : ''), onclick: () => setMode('slot') }, 'By slot')),
      ageLine(),
      state.staffMode === 'slot' ? slotGrid() : personTable(),
      h('div', { class: 'sub', style: 'margin-top:8px' },
        h('span', { class: 'hi' }, '✓'), ' notified · ', h('span', { class: 'lo' }, '•'), ' not notified · ', h('span', { class: 'inf' }, '↺'), ' did this role last season · ',
        h('span', { class: 'bd' }, '⚠'), ' training incomplete · ', h('span', { class: 'agemark bd' }, '16'), ' under minimum age · ',
        h('span', { class: 'agemark lo' }, '17'), ' under preferred age · ', h('span', { class: 'inf' }, '+'), ' staged · × remove'));

    const q = state.poolSearch.toLowerCase();
    const buildPool = (withAssigned) => state.people.map((p) => {
      const opts = withRole.map((l) => {
        if (!p.ev[l.ev.id]) return null;
        const real = realAssign(p, l.ev.id);
        if (real.some((a) => a.role === cur)) return null;
        // Roles the person is staged to leave no longer count against them.
        const mine = real.filter((a) => !removalOf(l.ev.id, a.role, p.id));
        if (mine.length && !withAssigned) return null;
        return {
          elsewhere: mine.map((a) => a.role),
          moving: real.filter((a) => removalOf(l.ev.id, a.role, p.id)).map((a) => a.role),
          lastSeason: p.ev[l.ev.id].lastSeason || '',
        };
      });
      if (!opts.some(Boolean)) return null;
      if (q && !(p.first + ' ' + p.last).toLowerCase().includes(q)) return null;
      const applied = withRole.flatMap((l) => (p.ev[l.ev.id] ? p.ev[l.ev.id].applied : []));
      const here = applied.filter((a) => a.role === cur).map((a) => Number(a.pref) || 99);
      const others = [...new Set(applied.map((a) => a.role).filter((r) => r !== cur))];
      let rank = 2, why = others.length ? 'Applied for ' + others.join(', ') : 'No application for this role';
      if (applied.some((a) => a.role === cur && a.otherDay)) { rank = 0; why = 'In this role on another day'; }
      else if (here.length) { rank = 0; const best = Math.min(...here); why = 'Applied for this role' + (best < 99 ? ', choice ' + best : ''); }
      else if (others.some((r) => /assign me as needed/i.test(r))) { rank = 1; why = 'Assign as needed'; }
      const kind = rank === 0 ? 'here' : rank === 1 ? 'needed' : 'other';
      if (opts.every((o) => !o || o.elsewhere.length)) rank = 3;
      const whens = withRole.map((l, i) => (opts[i] && p.ev[l.ev.id] ? p.ev[l.ev.id].appliedOn : null)).filter(Boolean);
      return { p, opts, rank, kind, why, best: here.length ? Math.min(...here) : 99, when: whens.length ? Math.min(...whens) : null };
    }).filter(Boolean).sort((a, b) => a.rank - b.rank || a.best - b.best
      || (a.when || Infinity) - (b.when || Infinity) || a.p.last.localeCompare(b.p.last));
    const poolAll = buildPool(state.showAssigned);
    // By default only people who applied for this role are listed; the other two groups are opt-in.
    const nNeeded = poolAll.filter((x) => x.kind === 'needed').length, nOther = poolAll.filter((x) => x.kind === 'other').length;
    const pool = poolAll.filter((x) => x.kind === 'here' || (x.kind === 'needed' && state.showNeeded) || (x.kind === 'other' && state.showOther));

    const isStaged = (p, l) => state.staged.some((x) => !x.remove && x.peopleId === p.id && x.evId === l.ev.id);
    const fillIdx = withRole.findIndex((l) => l.ev.id === fillDay);
    const poolTotal = pool.length;
    const forDay = (list) => (fillIdx < 0 ? list : list.filter(({ p, opts }) => !!opts[fillIdx] && !isStaged(p, withRole[fillIdx])));
    let shownPool = forDay(pool);
    // A search that finds nobody in the list looks past the checkboxes, so a filter never hides a name you typed.
    let widened = false;
    if (q && !shownPool.length) {
      const wide = forDay(buildPool(true));
      if (wide.length) { shownPool = wide; widened = true; }
    }
    const stage = (p, items) => {
      items.forEach((l) => state.staged.push({ evId: l.ev.id, role: cur, peopleId: p.id, name: p.first + ' ' + p.last }));
      state.staffConfirm = false; state.staffResult = null; renderMain();
    };
    const curCustom = withRole.some((l) => roleIn(l, cur).custom);
    const poolRows = shownPool.map(({ p, opts, kind, why, when }) => {
      const can = (i) => !!opts[i] && p.cleared && !isStaged(p, withRole[i]) && !busy;
      // "All" means the event days; a setup day is only ever assigned on its own.
      const all = withRole.map((l, i) => i).filter((i) => !!opts[i] && !withRole[i].ev.setup);
      const nDays = withRole.filter((l) => !l.ev.setup).length;
      return h('div', { class: 'prow' },
        h('div', {},
          nameLink(p, staffName(p.id, p.first + ' ' + p.last)), noteMark(p.id),
          (() => {
            // With many events, count the days instead of listing them all; the full list is in the tooltip.
            const days = withRole.filter((l, i) => !!opts[i] && !l.ev.setup).map((l) => evShort(l.ev));
            const list = days.length > 2 && days.length === nDays ? 'every day'
              : days.length > 3 ? days.length + ' of ' + nDays + ' days'
                : days.length > 2 ? days.slice(0, -1).join(', ') + ' and ' + days[days.length - 1] : days.join(' and ');
            return h('div', { class: 'sub', title: days.length > 2 ? days.join(', ') : '' }, why + ' · signed up for ' + list + (when ? ' · applied ' + fmtDay(when) : ''));
          })()),
        h('div', { class: 'pflags' },
          (() => {
            const rule = strictestRule(cur, withRole.filter((l, i) => !!opts[i]));
            const issue = ageIssue(p, rule);
            if (issue === 'under') return chip('bad', 'Age ' + p.age + ': under ' + rule.min, 'FIRST recommends ' + ageText(rule) + ' for this role. Exceptions need approval from your Program Delivery Partner.');
            if (issue === 'pref') return chip('warn', 'Age ' + p.age + ': ' + rule.pref + '+ preferred', 'FIRST recommends ' + ageText(rule) + ' for this role.');
            return p.flags.includes('minor') ? chip('info', 'Minor', 'Age ' + p.age) : null;
          })(),
          !p.cleared ? chip('bad', 'Needs clearance', p.clearance) : null,
          (() => {
            const seasons = opts.map((o) => (o ? o.lastSeason : '')).filter(Boolean);
            if (!seasons.length) return null;
            return seasons.some((t) => t.toLowerCase().includes(cur.toLowerCase()))
              ? chip('ok', 'Did this role last season', seasons.join(' / '))
              : chip('info', 'Last season: ' + (seasons[0].length > 34 ? seasons[0].slice(0, 32) + '…' : seasons[0]), seasons.join(' / '));
          })(),
          opts.map((o, i) => (o && o.moving.length ? chip('info', evShort(withRole[i].ev) + ': moving from ' + o.moving.join(', ')) : null)),
          opts.map((o, i) => (o && o.elsewhere.length ? chip('warn', evShort(withRole[i].ev) + ': already ' + o.elsewhere.join(', ')) : null))),
        h('div', { class: 'pacts' },
          !p.cleared ? h('span', { class: 'sub' }, 'Cannot be assigned yet') : [
            fillIdx >= 0
              ? h('button', { class: 'primary', disabled: !can(fillIdx), onclick: () => stage(p, [withRole[fillIdx]]) }, 'Assign ' + evShort(withRole[fillIdx].ev))
              : withRole.map((l, i) => h('button', { disabled: !can(i), onclick: () => stage(p, [l]) }, evShort(l.ev))),
            nDays > 1 ? h('button', { disabled: all.length < 2 || !all.every(can), title: withRole.some((l) => l.ev.setup) ? 'Every event day, not setup days' : '',
              onclick: () => stage(p, all.map((i) => withRole[i])) }, all.length > 2 ? 'All' : 'Both') : null,
          ],
          // Hiding is for people who are not placed anywhere: it takes them out of the applicant lists.
          opts.some((o) => o && o.elsewhere.length) || state.staged.some((x) => x.peopleId === p.id) ? null : h('div', {},
            state.hideAsk !== p.id
              ? h('button', { class: 'lnk', style: 'margin-right:0', title: 'Take this person out of the applicant list. They are not told.', onclick: () => { state.hideAsk = p.id; renderMain(); } }, 'Hide')
              : [kind === 'here' && !curCustom ? h('button', { class: 'lnk', disabled: state.hiding, onclick: () => hidePerson(p, cur, 'role') }, 'Hide from this role') : null,
                h('button', { class: 'lnk', disabled: state.hiding, onclick: () => hidePerson(p, cur, 'all') }, 'Hide from all roles'),
                h('button', { class: 'lnk', style: 'margin-right:0', disabled: state.hiding, onclick: () => { state.hideAsk = null; renderMain(); } }, 'Cancel')])));
    });

    // People hidden from this role, or from every role, on the loaded events.
    const hiddenMap = new Map();
    [...new Set(withRole.map((l) => l.src))].forEach((raw) => {
      const role = raw.roles.find((r) => r.name.toLowerCase() === cur.toLowerCase() && !r.admin);
      const add = (row, scope) => {
        if (!hiddenMap.has(row.PeopleID)) hiddenMap.set(row.PeopleID, { row, records: [] });
        hiddenMap.get(row.PeopleID).records.push({ raw, row, scope });
      };
      (role && role.hidden ? role.hidden : []).forEach((row) => add(row, 'role'));
      (raw.eventHidden || []).forEach((row) => add(row, 'all'));
    });
    const hiddenList = [...hiddenMap.values()].sort((a, b) => (a.row.LastName || '').localeCompare(b.row.LastName || ''));
    const hiddenBox = hiddenList.length ? h('details', { style: 'margin:10px 0 0' },
      h('summary', {}, 'Hidden (' + hiddenList.length + ')'),
      hiddenList.map(({ row, records }) => h('div', { class: 'prow', style: 'grid-template-columns: minmax(0, 1fr) auto' },
        h('div', {},
          h('strong', {}, staffName(row.PeopleID, fullName(row))),
          h('div', { class: 'sub' }, records.map((x) => (x.scope === 'all' ? 'From all roles' : 'From this role') + ' on ' + evShort(x.raw.ev)).join(' · '))),
        h('div', {}, h('button', { disabled: state.hiding, onclick: () => unhidePerson(records, cur) }, 'Unhide'))))) : null;

    const n = state.staged.length;
    const adds = state.staged.filter((x) => !x.remove).length;
    const told = state.staged.filter((x) => x.remove && x.notified).length;
    const summary = [adds ? plural(adds, 'assignment') : '', n - adds ? plural(n - adds, 'removal') : ''].filter(Boolean).join(' and ');
    // With changes staged, the bar stays at the bottom of the screen while the lists above it are longer than the page.
    const footer = h('div', { class: 'card bar' + (n ? ' stickybar' : ''), style: 'margin-bottom:0' },
      h('span', { class: 'muted grow' }, n ? 'Staged: ' + summary + ', kept in this browser until you apply or discard' : 'Nothing staged'),
      state.staffConfirm
        ? [h('strong', {}, 'Apply ' + summary + ' to VMS? No email is sent.'
            + (told ? ' VMS will not tell the ' + (told === 1 ? 'one person' : told + ' people') + ' already notified that they were removed.' : '')),
          h('button', { class: 'primary', disabled: busy, onclick: applyStaged }, busy ? 'Applying…' : 'Yes, apply'),
          h('button', { disabled: busy, onclick: () => { state.staffConfirm = false; renderMain(); } }, 'Cancel')]
        : [h('button', { disabled: !n, onclick: () => { state.staged = []; state.restoreNote = ''; render(); } }, 'Discard'),
          h('button', { class: 'primary', disabled: !n, onclick: () => { state.staffConfirm = true; renderMain(); } }, 'Apply ' + n + ' to VMS…')]);

    return h('div', { class: 'board' },
      roleList,
      h('div', {},
        state.restoreNote ? h('div', { class: 'msg' }, state.restoreNote) : null,
        resultBox(state.staffResult, (ok) => plural(ok, 'change') + ' made in VMS.', 'New assignments are not notified yet; use the Notify tab when ready.'),
        roleCard,
        h('div', { class: 'card' },
          h('div', { class: 'bar' },
            h('strong', {}, 'Available people'),
            fillIdx >= 0 ? h('span', { class: 'filltag' }, 'For ' + evShort(withRole[fillIdx].ev) + ' only',
              h('button', { class: 'xbtn', title: 'Show everyone again', onclick: stopFill }, '×')) : null,
            h('input', { type: 'search', placeholder: 'Search name', value: state.poolSearch,
              oninput: (e) => { state.poolSearch = e.target.value; refreshPeople(); } }),
            h('label', { title: 'People who ticked "Assign me as needed" but did not apply for this role' },
              h('input', { type: 'checkbox', checked: state.showNeeded,
                onchange: (e) => { state.showNeeded = e.target.checked; renderMain(); } }), ' Include assign as needed (' + nNeeded + ')'),
            h('label', { title: 'People who applied only for other roles' },
              h('input', { type: 'checkbox', checked: state.showOther,
                onchange: (e) => { state.showOther = e.target.checked; renderMain(); } }), ' Include other applicants (' + nOther + ')'),
            h('label', {}, h('input', { type: 'checkbox', checked: state.showAssigned,
              onchange: (e) => { state.showAssigned = e.target.checked; renderMain(); } }), ' Include people already assigned another role'),
            h('label', { title: 'For screenshots. Applies to the Staffing tab only; the details panel still shows everything.' },
              h('input', { type: 'checkbox', checked: state.hideLast,
                onchange: (e) => { state.hideLast = e.target.checked; renderMain(); } }), ' Hide last names'),
            h('span', { class: 'muted grow', style: 'text-align:right' }, fillIdx >= 0 ? shownPool.length + ' of ' + plural(poolTotal, 'person').replace('persons', 'people')
              : plural(poolTotal, 'person').replace('persons', 'people'))),
          widened ? h('div', { class: 'msg' }, 'Nobody in the current list matches "' + state.poolSearch + '". Showing '
            + plural(shownPool.length, 'other person').replace('persons', 'people') + ' the boxes above would normally hide.') : null,
          poolRows.length ? poolRows : h('div', { class: 'sub' }, q ? 'Nobody matches "' + state.poolSearch + '"' + (fillIdx >= 0 ? ' for this day.' : '.')
            : fillIdx >= 0 ? 'Nobody listed signed up for this day.'
            : nNeeded + nOther ? 'Nobody else applied for this role. Tick a box above to see other people.' : 'Nobody left to assign for this role.'),
          hiddenBox),
        footer));
  }

  async function applyStaged() {
    state.staffApplying = true; renderMain();
    const failed = [];
    let ok = 0;
    const touched = new Map();
    const placedNow = new Set();
    // Removals go first so that someone being moved is free before they are placed again.
    const ordered = [...state.staged.filter((x) => x.remove), ...state.staged.filter((x) => !x.remove)];
    for (const x of ordered) {
      const item = state.loaded.find((l) => l.ev.id === x.evId);
      const role = roleIn(item, x.role);
      if (x.remove) {
        // Someone removed goes back into the applicant lists of every role they applied for, which is not known here.
        mark(touched, x.evId, null);
      } else {
        mark(touched, x.evId, x.role);
        const person = state.people.find((y) => y.id === x.peopleId);
        (person && person.ev[x.evId] ? person.ev[x.evId].applied : []).forEach((a) => mark(touched, x.evId, a.role));
      }
      const vmsId = item.ev.vmsId;
      try {
        if (x.remove) {
          const row = role.assigned.find((v) => v.PeopleID === x.peopleId);
          if (!row) throw new Error('no longer in this role');
          if (item.ev.multi) {
            const live = await liveRow(item, role, x.peopleId);
            if (!live) throw new Error('no longer in this role');
            const shifts = live.Assignments || [];
            const a = shifts.find((sh) => covers(sh, item.ev.pos));
            if (!shifts.length || (a && shifts.length === 1 && (a.PositionsSpanned || 1) === 1)) {
              // Nothing left on any other day: take them out of the role.
              await svcPost('Remove', { eventID: vmsId, idList: String(live.ID) });
            } else if (a) {
              // Still working other days: take away only this day.
              await carveDay(item, live.ID, a, item.ev.pos, null);
            }
          } else {
            await svcPost('Remove', { eventID: vmsId, idList: String(row.ID) });
          }
          ok += 1;
          continue;
        }
        // On a multi-day event the person may already be in the role for another day.
        const srcRole = item.src.roles.find((r) => r.id === role.id && r.custom === role.custom);
        // Staging several days at once places them on the first day and only adds a shift on the others: VMS refuses to
        // place someone twice ("is already placed for this role"), and the loaded lists aren't re-read mid-batch.
        const placedKey = vmsId + ':' + role.id + ':' + (role.custom ? 1 : 0) + ':' + x.peopleId;
        const already = placedNow.has(placedKey)
          || (item.ev.multi && srcRole && (Array.isArray(srcRole.assigned) ? srcRole.assigned : []).some((v) => v.PeopleID === x.peopleId));
        if (!already) {
          try {
            await svcPost('PlaceCandidates', { eventID: vmsId, roleID: role.id, isCustom: role.custom, people: String(x.peopleId) });
          } catch (e) {
            if (!(item.ev.multi && /already placed/i.test(e.message))) throw e;
          }
        }
        placedNow.add(placedKey);
        const day = vmsDate(item.ev.date);
        if (item.ev.days === 1 && day) {
          const rows = await svc('GetAssignedVolunteers', { eventID: vmsId, roleID: role.id, isCustom: role.custom, viewType: 'Event', day: 0 });
          const row = rows.find((v) => v.PeopleID === x.peopleId);
          if (!row) throw new Error('placed, but not found on the schedule');
          const has = item.ev.multi ? (row.Assignments || []).some((a) => covers(a, item.ev.pos)) : (row.Assignments || []).length > 0;
          if (!has) {
            const want = effectiveTime(x.evId, x.role);
            await svcPost('SaveAssignment', {
              eventID: vmsId, peopleRoleID: String(row.ID), assignmentID: '0', assignmentType: 'Tentative',
              startDate: day, endDate: day, startTime: want ? want.start : '', endTime: want ? want.end : '',
              duplicateVolunteerIDs: [],
            });
          }
        }
        ok += 1;
      } catch (e) {
        failed.push(staffName(x.peopleId, x.name) + (x.remove ? ' from ' : ' as ') + x.role + ' (' + e.message + ')');
      }
    }
    await reloadEvents(touched);
    state.staged = []; state.staffApplying = false; state.staffConfirm = false;
    state.staffResult = { ok, failed };
    render();
  }

  // ----- Notify tab -----

  // Everyone with a shift that VMS has not emailed them about yet.
  function pendingNotifications() {
    const out = [];
    state.loaded.forEach(({ ev, roles }) => roles.forEach((role) => {
      if (role.admin) return;
      (Array.isArray(role.assigned) ? role.assigned : []).forEach((v) => {
        const shifts = v.Assignments || [];
        if (!shifts.length || shifts.every((a) => a.IsNotified)) return;
        const key = ev.vmsId + ':' + role.id + ':' + v.ID;
        const time = (ev.multi ? evShort(ev) + ' ' : '') + shifts.map((a) => a.ScheduleDisplayTime).join(', ');
        const prior = out.find((x) => x.key === key);
        if (prior) { prior.time += '; ' + time; return; }
        out.push({ key, ev, role, rowId: v.ID, peopleId: v.PeopleID, name: fullName(v), time });
      });
    }));
    return out;
  }

  function notifyView() {
    const nt = state.notify;
    const pending = pendingNotifications();
    const live = new Set(pending.map((x) => x.key));
    [...nt.picks.keys()].forEach((k) => { if (!live.has(k)) nt.picks.delete(k); });
    pending.forEach((x) => { if (!nt.picks.has(x.key)) nt.picks.set(x.key, true); });
    const picked = pending.filter((x) => nt.picks.get(x.key));
    const perPerson = new Map();
    picked.forEach((x) => perPerson.set(x.peopleId, (perPerson.get(x.peopleId) || 0) + 1));
    const multi = [...perPerson.values()].filter((c) => c > 1).length;
    const summary = plural(picked.length, 'email') + ' to ' + plural(perPerson.size, 'person').replace('persons', 'people')
      + (multi ? ' · ' + multi + ' will get more than one (VMS sends one per event and role)' : '');
    const repick = () => { nt.confirming = false; renderMain(); };

    return h('div', {},
      h('div', { class: 'msg' }, 'Sends the standard VMS assignment email to everyone ticked below, one email per person per event and role. '
        + 'The same subject and message go to all of them. VMS sends from a no-reply address, so put your contact details in the message.'),
      resultBox(nt.result, (ok) => plural(ok, 'email') + ' sent by VMS.', ''),
      nt.error ? h('div', { class: 'msg err' }, nt.error) : null,
      !pending.length ? h('div', { class: 'msg' }, 'Everyone with a shift has been notified.') : [
        h('label', { class: 'field' }, h('span', {}, 'Subject'),
          h('input', { type: 'text', value: nt.subject, disabled: nt.sending, oninput: (e) => { nt.subject = e.target.value; nt.error = ''; saveDrafts(); } })),
        h('label', { class: 'field' }, h('span', {}, 'Message'),
          h('textarea', { rows: 5, value: nt.message, disabled: nt.sending, oninput: (e) => { nt.message = e.target.value; saveDrafts(); } })),
        h('label', { class: 'field' }, h('input', { type: 'checkbox', checked: nt.bcc, disabled: nt.sending,
          onchange: (e) => { nt.bcc = e.target.checked; repick(); } }),
          ' BCC me on every email' + (nt.bcc ? ' (' + plural(picked.length, 'copy').replace('copys', 'copies') + ' to your inbox)' : '')),
        h('label', { class: 'field', title: 'The same option as in VMS\'s own Notify form' },
          h('input', { type: 'checkbox', checked: nt.other, disabled: nt.sending, onchange: (e) => {
            nt.other = e.target.checked;
            nt.error = '';
            if (nt.other && !nt.otherEmail && vmsExtraEmail) nt.otherEmail = vmsExtraEmail;
            // VMS fills this box with the extra email on your VMS profile; read it from a role page the first time.
            if (nt.other && !nt.otherEmail && picked.length) {
              loadExtraEmail(picked[0]).then(() => { if (nt.other && !nt.otherEmail && vmsExtraEmail) { nt.otherEmail = vmsExtraEmail; renderMain(); } });
            }
            repick();
          } }),
          ' Include this email address in the message: ',
          h('input', { type: 'email', class: 'otheremail', value: nt.otherEmail, disabled: nt.sending, placeholder: 'name@example.org',
            oninput: (e) => { nt.otherEmail = e.target.value; nt.error = ''; if (e.target.value.trim() && !nt.other) { nt.other = true; e.target.previousSibling.previousSibling.checked = true; } } })),
        h('div', { class: 'bar' },
          h('span', { class: 'muted grow' }, summary),
          nt.confirming
            ? [h('strong', {}, 'Send ' + plural(picked.length, 'email') + (nt.other ? ' that include ' + nt.otherEmail.trim() : '') + ' now? This cannot be undone.'),
              h('button', { class: 'primary', disabled: nt.sending, onclick: () => sendNotifications(picked) }, nt.sending ? 'Sending…' : 'Yes, send'),
              h('button', { disabled: nt.sending, onclick: repick }, 'Cancel')]
            : h('button', { class: 'primary', disabled: !picked.length, onclick: () => {
                if (!nt.subject.trim()) { nt.error = 'Enter a subject first.'; renderMain(); return; }
              if (nt.other && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(nt.otherEmail.trim())) { nt.error = 'Enter one email address to include, or untick that box.'; renderMain(); return; }
                nt.confirming = true; renderMain();
              } }, 'Send ' + plural(picked.length, 'email') + '…')),
        h('table', {},
          h('thead', {}, h('tr', {},
            h('th', {}, h('input', { type: 'checkbox', checked: picked.length === pending.length, disabled: nt.sending, title: 'Select all',
              onchange: (e) => { pending.forEach((x) => nt.picks.set(x.key, e.target.checked)); repick(); } })),
            ['Volunteer', 'Event', 'Role', 'Shift'].map((t) => h('th', {}, t)))),
          h('tbody', {}, pending.map((x) => h('tr', {},
            h('td', {}, h('input', { type: 'checkbox', checked: nt.picks.get(x.key), disabled: nt.sending,
              onchange: (e) => { nt.picks.set(x.key, e.target.checked); repick(); } })),
            h('td', {}, x.name), h('td', {}, x.ev.multi ? x.ev.name : evLabel(x.ev)), h('td', {}, x.role.name), h('td', {}, x.time))))),
      ]);
  }

  async function sendNotifications(picked) {
    const nt = state.notify;
    nt.sending = true; renderMain();
    const failed = [];
    let ok = 0;
    const touched = new Map();
    // One call per person: the only form of this call that has been verified against VMS.
    for (const x of picked) {
      mark(touched, x.ev.id, x.role.name);
      try {
        await svcPost('NotifyVolunteers', {
          eventID: x.ev.vmsId, idList: String(x.rowId), subject: nt.subject.trim(), ccMe: nt.bcc, ccVC: false,
          customMessage: nt.message, emailEA: '', emailEEA: nt.other ? nt.otherEmail.trim() : '', roleID: x.role.id,
        });
        ok += 1;
      } catch (e) {
        failed.push(x.name + ' as ' + x.role.name + ' (' + e.message + ')');
      }
    }
    await reloadEvents(touched);
    nt.sending = false; nt.confirming = false; nt.picks.clear();
    nt.result = { ok, failed };
    render();
  }

  // ----- Message tab -----

  // People VMS will email for an event, set of roles and audience, as far as the loaded data shows.
  function messageAudience() {
    const m = state.msg;
    const evIds = m.evs || new Set(state.loaded.map((l) => l.ev.id));
    const ids = new Set();
    const perEvent = [];
    state.loaded.forEach((l) => {
      if (!evIds.has(l.ev.id)) return;
      const roles = l.roles.filter((r) => !r.admin && (m.allRoles || m.roles.has(r.name)));
      if (!roles.length) return;
      roles.forEach((r) => {
        const told = (v) => (v.Assignments || []).some((a) => a.IsNotified);
        const add = (list) => list.forEach((v) => ids.add(v.PeopleID));
        const assigned = Array.isArray(r.assigned) ? r.assigned : [], applicants = Array.isArray(r.applicants) ? r.applicants : [];
        if (m.aud === '0' || m.aud === '3') add(assigned.filter(told));
        if (m.aud === '1' || m.aud === '3') add(assigned.filter((v) => !told(v)));
        if (m.aud === '2' || m.aud === '3') add(applicants);
      });
      if (!perEvent.some((x) => x.ev.vmsId === l.ev.vmsId)) perEvent.push({ ev: l.ev, roles });
    });
    return { count: ids.size, perEvent };
  }

  function messageView() {
    const m = state.msg;
    const loaded = state.loaded;
    const evIds = m.evs || new Set(loaded.map((l) => l.ev.id));
    const roleNames = [...new Set(loaded.flatMap((l) => l.roles.filter((r) => !r.admin).map((r) => r.name)))].sort();
    const aud = messageAudience();
    const reset = () => { m.confirming = false; m.result = null; renderMain(); };
    const AUDIENCES = [['0', 'Assigned and notified'], ['1', 'Tentatively scheduled (not notified yet)'], ['2', 'Applicants not assigned'], ['3', 'Everyone']];

    return h('div', {},
      h('div', { class: 'msg' }, 'Sends a VMS message to everyone in the chosen roles with the chosen status. VMS sends it from a no-reply address, '
        + 'so include your name and contact details. To write from your own email instead, use "Copy emails for BCC" on the People tab.'),
      resultBox(m.result, (ok) => 'Message sent for ' + plural(ok, 'event') + '.', ''),
      m.error ? h('div', { class: 'msg err' }, m.error) : null,
      h('div', { class: 'field' }, h('span', {}, 'Events'),
        loaded.map((l) => h('label', { style: 'margin-right:16px' }, h('input', { type: 'checkbox', checked: evIds.has(l.ev.id), disabled: m.sending,
          onchange: (e) => { const next = new Set(evIds); e.target.checked ? next.add(l.ev.id) : next.delete(l.ev.id); m.evs = next; reset(); } }), ' ' + evLabel(l.ev)))),
      h('label', { class: 'field' }, h('span', {}, 'Send to'),
        h('select', { disabled: m.sending, onchange: (e) => { m.aud = e.target.value; reset(); } },
          AUDIENCES.map(([v, label]) => h('option', { value: v, selected: m.aud === v }, label)))),
      h('div', { class: 'field' }, h('span', {}, 'Roles'),
        h('label', {}, h('input', { type: 'checkbox', checked: m.allRoles, disabled: m.sending,
          onchange: (e) => { m.allRoles = e.target.checked; reset(); } }), ' All roles'),
        m.allRoles ? null : h('div', { class: 'checks' }, roleNames.map((name) => h('label', {}, h('input', { type: 'checkbox', checked: m.roles.has(name), disabled: m.sending,
          onchange: (e) => { e.target.checked ? m.roles.add(name) : m.roles.delete(name); reset(); } }), ' ' + name)))),
      h('label', { class: 'field' }, h('span', {}, 'Subject'),
        h('input', { type: 'text', value: m.subject, disabled: m.sending, oninput: (e) => { m.subject = e.target.value; m.error = ''; } })),
      h('label', { class: 'field' }, h('span', {}, 'Message'),
        h('textarea', { rows: 6, value: m.message, disabled: m.sending, oninput: (e) => { m.message = e.target.value; m.error = ''; } })),
      h('label', { class: 'field' }, h('input', { type: 'checkbox', checked: m.bcc, disabled: m.sending,
        onchange: (e) => { m.bcc = e.target.checked; reset(); } }), ' BCC me (one copy per event)'),
      h('div', { class: 'bar' },
        h('span', { class: 'muted grow' }, aud.count
          ? 'About ' + plural(aud.count, 'person').replace('persons', 'people') + ' across ' + plural(aud.perEvent.length, 'event') + '. VMS decides the exact list when it sends.'
          : 'Nobody matches this choice.'),
        m.confirming
          ? [h('strong', {}, 'Email about ' + plural(aud.count, 'person').replace('persons', 'people') + ' now? This cannot be undone.'),
            h('button', { class: 'primary', disabled: m.sending, onclick: () => sendMessage(aud) }, m.sending ? 'Sending…' : 'Yes, send'),
            h('button', { disabled: m.sending, onclick: () => { m.confirming = false; renderMain(); } }, 'Cancel')]
          : h('button', { class: 'primary', disabled: !aud.count, onclick: () => {
              if (!m.subject.trim() || !m.message.trim()) { m.error = 'Enter a subject and a message first.'; renderMain(); return; }
              m.confirming = true; renderMain();
            } }, 'Send message…')));
  }

  async function sendMessage(aud) {
    const m = state.msg;
    m.sending = true; renderMain();
    const failed = [];
    let ok = 0;
    for (const { ev, roles } of aud.perEvent) {
      try {
        await postJson('/VMS/Services/EventsService.asmx/SendMessage', {
          eventID: ev.vmsId, roleIDList: roles.map((r) => r.id + '|' + r.custom).join(','), subject: m.subject.trim(),
          ccMe: m.bcc, ccVC: false, customMessage: m.message, sendMessageTo: m.aud,
        });
        ok += 1;
      } catch (e) {
        failed.push(evShort(ev) + ' (' + e.message + ')');
      }
    }
    m.sending = false; m.confirming = false;
    m.result = { ok, failed };
    renderMain();
  }

  // ----- Shift times tab -----

  // Chrome reports a time box as changed as soon as its time is complete, while the cursor is still in it. Redrawing the
  // tab then would throw the cursor out of the form, so the value is saved at once and the tab is redrawn after the
  // cursor leaves the box, with focus kept on wherever it went.
  function redrawTimesLater() {
    setTimeout(() => {
      if (!timesDirty) return;
      const now = shadow.activeElement;
      // Focus moved to a button or other control: let its click happen first, then redraw.
      if (now && mainEl.contains(now) && !(now.dataset && now.dataset.fk)) {
        const after = () => { now.removeEventListener('click', after); setTimeout(() => { if (timesDirty) renderMain(); }, 0); };
        now.addEventListener('click', after);
        now.addEventListener('blur', after, { once: true });
        return;
      }
      renderMain();
    }, 0);
  }
  function timeInputs(target, key) {
    const mk = (field) => h('input', {
      type: 'time', min: MIN_TIME, max: MAX_TIME, value: target[field] || '', disabled: state.applying, 'data-fk': key + ':' + field,
      onchange: (e) => { target[field] = e.target.value; saveTimes(); state.confirming = false; state.applyResult = null; timesDirty = true; },
      onblur: () => { if (timesDirty) redrawTimesLater(); },
    });
    return [mk('start'), ' to ', mk('end')];
  }

  function timesView() {
    const changed = () => { saveTimes(); state.confirming = false; state.applyResult = null; renderMain(); };
    const sections = state.loaded.map(({ ev, roles }) => {
      const cfg = cfgFor(ev.id);
      if (ev.days > 1 || !vmsDate(ev.date)) {
        return h('section', {}, h('h2', {}, evLabel(ev)),
          h('div', { class: 'msg' }, 'Shift times are only supported for one-day events. Set this one in VMS.'));
      }
      const usable = roles.filter((r) => !r.admin && !r.inactive).sort((a, b) => a.name.localeCompare(b.name));
      const setCount = usable.filter((r) => validTime(cfg.roles[r.name.toLowerCase()])).length;
      // On a multi-day event, the first day's times can be copied to every other day in one click.
      const sameEvent = state.loaded.filter((l) => l.ev.vmsId === ev.vmsId && l.ev.id !== ev.id && !l.ev.setup);
      const isFirstDay = ev.multi && !ev.setup && state.loaded.find((l) => l.ev.vmsId === ev.vmsId && !l.ev.setup).ev.id === ev.id;
      const copyToOtherDays = () => {
        sameEvent.forEach((l) => {
          const to = cfgFor(l.ev.id);
          to.start = cfg.start; to.end = cfg.end;
          to.roles = JSON.parse(JSON.stringify(cfg.roles));
        });
        state.toast = 'Copied to ' + plural(sameEvent.length, 'other day') + '. Nothing changes in VMS until you apply.';
        changed();
        setTimeout(() => { state.toast = ''; render(); }, 2500);
      };
      const bad = (t) => !!t && (t.start || t.end) && !validTime(t);
      return h('section', {},
        h('h2', {}, evLabel(ev)),
        h('div', { class: 'bar' }, h('strong', {}, 'Default shift'), timeInputs(cfg, ev.id + '|*'),
          bad(cfg) ? chip('bad', 'Needs a start before the end, between 6am and 10pm') : null,
          !cfg.start && !cfg.end ? h('span', { class: 'muted' }, 'Not set. Roles without their own time are left alone.') : null,
          isFirstDay && sameEvent.length ? h('button', { title: 'Copy this day’s default and role times to the other days of this event', onclick: copyToOtherDays },
            'Use these times on all ' + (sameEvent.length + 1) + ' days') : null),
        h('details', { open: setCount > 0 },
          h('summary', {}, 'Role-specific times (' + setCount + ' set)'),
          h('table', { class: 'narrow' }, h('tbody', {}, usable.map((r) => {
            const k = r.name.toLowerCase();
            const own = (cfg.roles[k] = cfg.roles[k] || { start: '', end: '' });
            const eff = effectiveTime(ev.id, r.name);
            return h('tr', {},
              h('td', {}, r.name),
              h('td', {}, timeInputs(own, ev.id + '|' + k),
                own.start || own.end ? [' ', h('button', { onclick: () => { own.start = ''; own.end = ''; changed(); } }, 'Clear')] : null,
                bad(own) ? [' ', chip('bad', 'Invalid, ignored')] : null),
              h('td', { class: 'muted' }, eff ? (validTime(own) ? 'Uses ' : 'Default ') + vmsRange(eff) : 'No time set'));
          })))));
    });

    const changes = plannedChanges();
    const live = new Set(changes.map((c) => c.key));
    [...state.picks.keys()].forEach((k) => { if (!live.has(k)) state.picks.delete(k); });
    changes.forEach((c) => { if (!state.picks.has(c.key)) state.picks.set(c.key, !c.notified); });
    const picked = changes.filter((c) => state.picks.get(c.key));
    const pickedNotified = picked.filter((c) => c.notified).length;

    const result = state.applyResult;
    const preview = h('section', {},
      h('h2', {}, 'Shifts that differ from these times'),
      result ? h('div', { class: 'msg' + (result.failed.length ? ' err' : '') },
        result.ok + ' shift' + (result.ok === 1 ? '' : 's') + ' updated in VMS.'
        + (result.failed.length ? ' ' + result.failed.length + ' failed: ' + result.failed.join('; ') : '')
        + (result.ok ? ' Updated shifts are marked not notified; send notifications from VMS when ready.' : '')) : null,
      !changes.length ? h('div', { class: 'msg' }, 'Nothing to change. Every assigned shift already matches, or no times are set.') : [
        h('div', { class: 'bar' },
          h('span', { class: 'muted grow' }, picked.length + ' of ' + changes.length + ' selected'
            + (pickedNotified ? ' · ' + pickedNotified + ' already notified' : '')),
          state.confirming
            ? [h('strong', {}, 'Change ' + picked.length + ' shift' + (picked.length === 1 ? '' : 's') + ' in VMS?'
                + (pickedNotified ? ' ' + pickedNotified + ' will go back to not notified.' : '')),
              h('button', { class: 'primary', disabled: state.applying, onclick: () => applyChanges(picked) }, state.applying ? 'Applying…' : 'Yes, apply'),
              h('button', { disabled: state.applying, onclick: () => { state.confirming = false; renderMain(); } }, 'Cancel')]
            : h('button', { class: 'primary', disabled: !picked.length, onclick: () => { state.confirming = true; renderMain(); } },
                'Apply ' + picked.length + ' change' + (picked.length === 1 ? '' : 's') + '…')),
        h('table', {},
          h('thead', {}, h('tr', {},
            h('th', {}, h('input', {
              type: 'checkbox', checked: picked.length === changes.length, disabled: state.applying, title: 'Select all',
              onchange: (e) => { changes.forEach((c) => state.picks.set(c.key, e.target.checked)); state.confirming = false; renderMain(); },
            })),
            ['Volunteer', 'Event', 'Role', 'Now', 'Change to', 'Status'].map((t) => h('th', {}, t)))),
          h('tbody', {}, changes.map((c) => h('tr', {},
            h('td', {}, h('input', {
              type: 'checkbox', checked: state.picks.get(c.key), disabled: state.applying,
              onchange: (e) => { state.picks.set(c.key, e.target.checked); state.confirming = false; renderMain(); },
            })),
            h('td', {}, c.name), h('td', {}, evLabel(c.ev)), h('td', {}, c.role),
            h('td', {}, c.from || 'No shift set'), h('td', {}, h('strong', {}, vmsRange(c.want))),
            h('td', {}, c.notified ? chip('warn', 'Notified: will need re-notifying') : chip('info', 'Not notified yet')))))),
      ]);

    return h('div', {},
      h('div', { class: 'msg' }, 'Set one shift time per event, and a different time for any role that needs it. '
        + 'Applying replaces the 6am–10pm default on assigned shifts. It never sends email: a shift that was already notified goes back to '
        + '"not notified", so those are left unticked until you choose them.'),
      sections, preview);
  }

  async function applyChanges(picked) {
    state.applying = true; renderMain();
    const failed = [];
    let ok = 0;
    const touched = new Map();
    for (const c of picked) {
      const day = vmsDate(c.ev.date);
      try {
        if (c.ev.multi) {
          const item = state.loaded.find((l) => l.ev.id === c.ev.id);
          const role = roleIn(item, c.role);
          const live = await liveRow(item, role, c.peopleId);
          if (!live) throw new Error('no longer in this role');
          const a = (live.Assignments || []).find((sh) => covers(sh, c.ev.pos));
          if (a) await carveDay(item, live.ID, a, c.ev.pos, c.want);
          else await saveShift(c.ev.vmsId, live.ID, 0, day, day, c.want);
        } else {
          await svcPost('SaveAssignment', {
            eventID: c.ev.vmsId, peopleRoleID: String(c.rowId), assignmentID: String(c.asgId),
            assignmentType: 'Tentative', startDate: day, endDate: day,
            startTime: c.want.start, endTime: c.want.end, duplicateVolunteerIDs: [],
          });
        }
        ok += 1;
      } catch (e) {
        failed.push(c.name.trim() + ' (' + e.message + ')');
      }
      mark(touched, c.ev.id, c.role);
    }
    // Re-read the roles that changed so the view shows what VMS now holds.
    await reloadEvents(touched);
    state.applying = false; state.confirming = false; state.picks.clear();
    state.applyResult = { ok, failed };
    render();
  }

  // Re-render the table without losing focus in the search box.
  function refreshPeople() {
    const old = mainEl.querySelector('input[type=search]');
    const pos = old ? old.selectionStart : null;
    renderMain();
    const box = mainEl.querySelector('input[type=search]');
    if (box && pos != null) { box.focus(); box.setSelectionRange(pos, pos); }
  }

  async function copyEmails(emails) {
    try {
      await navigator.clipboard.writeText(emails.join('; '));
      toast('Copied ' + emails.length + (emails.length === 1 ? ' email' : ' emails') + '. Paste into BCC.');
    } catch (e) {
      toast('Could not copy: ' + e.message);
    }
  }
  function toast(message) {
    state.toast = message; render();
    setTimeout(() => { state.toast = ''; render(); }, 2500);
  }
})();
