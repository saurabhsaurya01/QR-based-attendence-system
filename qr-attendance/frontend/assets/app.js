/* ===================================================================
   QR ATTENDANCE SYSTEM - shared browser code
   Made by Saurav

   Two jobs:
     1. Talk to Amazon Cognito (login) and to your Lambda (everything else)
     2. If config.js is still empty, run a complete DEMO backend right
        here in the browser so you can test the whole app with no AWS
   =================================================================== */

const CFG = window.CONFIG || {};
const DEMO = !CFG.API_URL || !CFG.USER_POOL_ID;

/* ---------- storage that never crashes ---------- */
const mem = {};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return mem[k] ?? null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { mem[k] = v; } },
  del(k) { try { localStorage.removeItem(k); } catch { delete mem[k]; } },
};

/* ---------- little helpers used by every page ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const when = (ms) => new Date(ms).toLocaleString(undefined,
  { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

function showMsg(box, text, kind = "info") {
  const el = typeof box === "string" ? $(box) : box;
  if (!el) return;
  el.className = "msg " + kind;
  el.textContent = text;
  el.classList.remove("hide");
}
function hideMsg(box) {
  const el = typeof box === "string" ? $(box) : box;
  if (el) el.classList.add("hide");
}

/* ===================================================================
   PART 1 - LOGIN (Amazon Cognito, called directly with fetch)
   =================================================================== */

async function cognito(action, payload) {
  const res = await fetch(`https://cognito-idp.${CFG.REGION}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService." + action,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.__type || "Cognito request failed");
  return data;
}

const Auth = {

  async register(email, password, name) {
    if (DEMO) return demoAuth.register(email, password, name);
    await cognito("SignUp", {
      ClientId: CFG.APP_CLIENT_ID,
      Username: email,
      Password: password,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "name", Value: name },
      ],
    });
    return { needsCode: true };
  },

  async confirm(email, code) {
    if (DEMO) return { ok: true };
    await cognito("ConfirmSignUp", {
      ClientId: CFG.APP_CLIENT_ID, Username: email, ConfirmationCode: code,
    });
    return { ok: true };
  },

  async resendCode(email) {
    if (DEMO) return { ok: true };
    await cognito("ResendConfirmationCode", { ClientId: CFG.APP_CLIENT_ID, Username: email });
    return { ok: true };
  },

  async login(email, password) {
    if (DEMO) return demoAuth.login(email, password);
    const r = await cognito("InitiateAuth", {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: CFG.APP_CLIENT_ID,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    });
    const t = r.AuthenticationResult;
    if (!t) throw new Error("Login did not return a token.");
    store.set("idToken", t.IdToken);
    store.set("refreshToken", t.RefreshToken || "");
    return { ok: true };
  },

  async refresh() {
    if (DEMO) return true;
    const rt = store.get("refreshToken");
    if (!rt) return false;
    try {
      const r = await cognito("InitiateAuth", {
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: CFG.APP_CLIENT_ID,
        AuthParameters: { REFRESH_TOKEN: rt },
      });
      if (r.AuthenticationResult?.IdToken) {
        store.set("idToken", r.AuthenticationResult.IdToken);
        return true;
      }
    } catch { /* fall through */ }
    return false;
  },

  logout() {
    store.del("idToken"); store.del("refreshToken"); store.del("demoUser");
    location.href = "index.html";
  },

  loggedIn() {
    return DEMO ? !!store.get("demoUser") : !!store.get("idToken");
  },
};

/* ===================================================================
   PART 2 - TALKING TO THE BACKEND
   =================================================================== */

async function api(method, path, { body, query } = {}) {
  if (DEMO) return demoApi(method, path, body || {}, query || {});

  const qs = query && Object.keys(query).length
    ? "?" + new URLSearchParams(query).toString() : "";

  const send = async () => fetch(CFG.API_URL + path + qs, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + (store.get("idToken") || ""),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let res = await send();
  if (res.status === 401 && await Auth.refresh()) res = await send();

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* Send the user to the right dashboard after login */
async function routeByRole() {
  const { user } = await api("GET", "/api/me");
  store.set("role", user.role);
  store.set("name", user.name || user.email);
  location.href = (user.role === "student") ? "student.html" : "teacher.html";
}

/* Every dashboard page calls this first */
async function guard(allowed) {
  if (!Auth.loggedIn()) { location.href = "index.html"; return null; }
  try {
    const { user } = await api("GET", "/api/me");
    if (!allowed.includes(user.role)) {
      location.href = user.role === "student" ? "student.html" : "teacher.html";
      return null;
    }
    const who = $(".who");
    if (who) who.textContent = `${user.name || user.email} · ${user.role}`;
    return user;
  } catch (e) {
    Auth.logout();
    return null;
  }
}

/* ===================================================================
   PART 3 - THE DEMO BACKEND
   Runs only when config.js is empty. It copies the real Lambda logic
   exactly, including the 10-second rotating QR code and the duplicate
   attendance block, so what you test here is what you get on AWS.
   =================================================================== */

const DB_KEY = "qrattend_demo_db";

function db() {
  let d;
  try { d = JSON.parse(store.get(DB_KEY) || "null"); } catch { d = null; }
  if (!d) {
    d = { users: {}, classes: {}, enroll: [], sessions: {}, attendance: [] };
    // Two ready-made accounts so you can demo instantly
    d.users["teacher@demo.com"] = {
      userId: "u_teacher", email: "teacher@demo.com", name: "Prof. Sharma",
      role: "teacher", password: "Demo@1234",
    };
    d.users["student@demo.com"] = {
      userId: "u_student", email: "student@demo.com", name: "Saurav",
      role: "student", password: "Demo@1234",
    };
    save(d);
  }
  return d;
}
function save(d) { store.set(DB_KEY, JSON.stringify(d)); }

const demoAuth = {
  register(email, password, name) {
    const d = db();
    email = email.toLowerCase().trim();
    if (d.users[email]) throw new Error("An account with this email already exists.");
    // Anyone whose email starts with "teacher" becomes a teacher in demo mode
    const role = email.startsWith("teacher") || email.startsWith("admin") ? "teacher" : "student";
    d.users[email] = { userId: "u_" + Math.random().toString(36).slice(2, 10),
                       email, name, role, password };
    save(d);
    return { needsCode: false };
  },
  login(email, password) {
    const d = db();
    const u = d.users[email.toLowerCase().trim()];
    if (!u || u.password !== password) throw new Error("Wrong email or password.");
    store.set("demoUser", u.email);
    return { ok: true };
  },
};

function demoMe() {
  const d = db();
  const u = d.users[store.get("demoUser")];
  if (!u) throw new Error("Not logged in.");
  return u;
}

/* the same rotating-token idea as the Lambda, simplified for the demo */
const WIN = 10000;
const nowWin = () => Math.floor(Date.now() / WIN);
function demoSign(text) {
  let h = 2166136261;
  for (const ch of text + "|demo-secret") { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
function demoMakeToken(sid) { const b = `${sid}.${nowWin()}`; return `${b}.${demoSign(b)}`; }
function demoReadToken(tok) {
  const p = String(tok || "").split(".");
  if (p.length !== 3) throw new Error("This QR code is not valid.");
  if (demoSign(p[0] + "." + p[1]) !== p[2]) throw new Error("This QR code is not valid.");
  if (Math.abs(nowWin() - Number(p[1])) > 1)
    throw new Error("This QR code has expired. Please scan the new one on screen.");
  return p[0];
}

const rid = (p) => p + "_" + Math.random().toString(36).slice(2, 10);
function code6() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => A[Math.floor(Math.random() * A.length)]).join("");
}

async function demoApi(method, path, body, query) {
  await new Promise((r) => setTimeout(r, 120)); // pretend network delay
  const d = db();
  const me = demoMe();
  const key = `${method} ${path}`;

  const sessionsOf = (cid) => Object.values(d.sessions)
    .filter((s) => s.classId === cid).sort((a, b) => b.startedAt - a.startedAt);

  switch (key) {

    case "GET /api/me":
      return { user: { userId: me.userId, email: me.email, name: me.name, role: me.role } };

    case "POST /api/classes": {
      const c = { classId: rid("cls"), name: body.name, subject: body.subject || "",
                  teacherId: me.userId, teacherName: me.name,
                  joinCode: code6(), createdAt: Date.now() };
      d.classes[c.classId] = c; save(d);
      return { class: c };
    }

    case "GET /api/classes": {
      if (me.role !== "student")
        return { classes: Object.values(d.classes).filter((c) => c.teacherId === me.userId) };
      const ids = d.enroll.filter((e) => e.studentId === me.userId).map((e) => e.classId);
      return { classes: ids.map((i) => d.classes[i]).filter(Boolean) };
    }

    case "POST /api/enrollments": {
      const st = d.users[String(body.email || "").toLowerCase().trim()];
      if (!st) throw new Error("No student found with that email. Ask them to register first.");
      if (!d.enroll.some((e) => e.classId === body.classId && e.studentId === st.userId))
        d.enroll.push({ classId: body.classId, studentId: st.userId,
                        studentName: st.name, studentEmail: st.email, enrolledAt: Date.now() });
      save(d);
      return { ok: true, student: { name: st.name, email: st.email } };
    }

    case "POST /api/enrollments/join": {
      const c = Object.values(d.classes)
        .find((x) => x.joinCode === String(body.joinCode || "").toUpperCase().trim());
      if (!c) throw new Error("No class found with that code.");
      if (!d.enroll.some((e) => e.classId === c.classId && e.studentId === me.userId))
        d.enroll.push({ classId: c.classId, studentId: me.userId,
                        studentName: me.name, studentEmail: me.email, enrolledAt: Date.now() });
      save(d);
      return { ok: true, class: c };
    }

    case "GET /api/enrollments":
      return { students: d.enroll.filter((e) => e.classId === query.classId) };

    case "POST /api/sessions": {
      const mins = Math.min(Math.max(Number(body.minutes) || 15, 1), 240);
      const c = d.classes[body.classId];
      const s = { sessionId: rid("ses"), classId: c.classId, className: c.name,
                  teacherId: me.userId, status: "OPEN", startedAt: Date.now(),
                  expiresAt: Date.now() + mins * 60000, minutes: mins };
      d.sessions[s.sessionId] = s; save(d);
      return { session: s };
    }

    case "POST /api/sessions/close":
      d.sessions[body.sessionId].status = "CLOSED";
      d.sessions[body.sessionId].closedAt = Date.now();
      save(d); return { ok: true };

    case "GET /api/sessions/qr": {
      const s = d.sessions[query.sessionId];
      if (!s) throw new Error("Attendance session not found.");
      if (s.status !== "OPEN") throw new Error("This session is closed.");
      if (Date.now() > s.expiresAt) throw new Error("This session has ended.");
      return { token: demoMakeToken(s.sessionId), validForSeconds: 10, sessionEndsAt: s.expiresAt };
    }

    case "GET /api/sessions/live": {
      const s = d.sessions[query.sessionId];
      const present = d.attendance.filter((a) => a.sessionId === s.sessionId)
        .sort((a, b) => b.markedAt - a.markedAt);
      const ids = new Set(present.map((p) => p.studentId));
      const absent = d.enroll.filter((e) => e.classId === s.classId && !ids.has(e.studentId));
      return { session: s, present, absent };
    }

    case "GET /api/sessions/history":
      return { sessions: sessionsOf(query.classId) };

    case "POST /api/attendance/mark": {
      const sid = demoReadToken(body.token);                    // checks 1 and 2
      const s = d.sessions[sid];
      if (!s) throw new Error("Attendance session not found.");
      if (s.status !== "OPEN") throw new Error("This attendance session is closed.");
      if (Date.now() > s.expiresAt) throw new Error("This attendance session has ended.");
      if (!d.enroll.some((e) => e.classId === s.classId && e.studentId === me.userId))
        throw new Error("You are not enrolled in this class.");
      if (d.attendance.some((a) => a.sessionId === sid && a.studentId === me.userId))
        return { ok: true, alreadyMarked: true, message: "You are already marked present." };
      d.attendance.push({ sessionId: sid, studentId: me.userId, studentName: me.name,
                          studentEmail: me.email, classId: s.classId, className: s.className,
                          markedAt: Date.now(), method: "QR" });
      save(d);
      return { ok: true, alreadyMarked: false, className: s.className,
               message: "Attendance marked successfully." };
    }

    case "POST /api/attendance/manual": {
      const s = d.sessions[body.sessionId];
      const st = d.users[String(body.email || "").toLowerCase().trim()];
      if (!st) throw new Error("No student found with that email.");
      if (!d.attendance.some((a) => a.sessionId === s.sessionId && a.studentId === st.userId))
        d.attendance.push({ sessionId: s.sessionId, studentId: st.userId, studentName: st.name,
                            studentEmail: st.email, classId: s.classId, className: s.className,
                            markedAt: Date.now(), method: "MANUAL", markedBy: me.email });
      save(d);
      return { ok: true };
    }

    case "GET /api/attendance/me": {
      const records = d.attendance.filter((a) => a.studentId === me.userId)
        .sort((a, b) => b.markedAt - a.markedAt);
      const summary = d.enroll.filter((e) => e.studentId === me.userId).map((e) => {
        const total = sessionsOf(e.classId).length;
        const att = records.filter((r) => r.classId === e.classId).length;
        return { classId: e.classId, className: d.classes[e.classId]?.name || "?",
                 totalSessions: total, attended: att,
                 percentage: total ? Math.round((att / total) * 100) : 0 };
      });
      return { records, summary };
    }

    case "GET /api/reports/class": {
      const total = sessionsOf(query.classId).length;
      const report = d.enroll.filter((e) => e.classId === query.classId).map((e) => {
        const att = d.attendance.filter(
          (a) => a.classId === query.classId && a.studentId === e.studentId).length;
        return { studentName: e.studentName, studentEmail: e.studentEmail, attended: att,
                 totalSessions: total, percentage: total ? Math.round((att / total) * 100) : 0 };
      }).sort((a, b) => a.studentName.localeCompare(b.studentName));
      return { totalSessions: total, report };
    }

    default:
      throw new Error("No such route: " + key);
  }
}

/* Show a banner on every page when we are not connected to AWS */
function demoBanner() {
  if (!DEMO) return;
  const b = document.createElement("div");
  b.style.cssText = "background:#C77400;color:#fff;padding:7px 14px;font-size:13px;" +
    "text-align:center;font-weight:600";
  b.textContent = "DEMO MODE - data is saved in this browser only. " +
    "Fill in assets/config.js to connect to AWS.";
  document.body.prepend(b);
}
document.addEventListener("DOMContentLoaded", demoBanner);
