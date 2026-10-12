/* =====================================================================
   QR CODE BASED ATTENDANCE SYSTEM  -  BACKEND
   Made by Saurav

   This ONE file is the whole backend. Paste it into the AWS Lambda
   code editor. It needs NO npm install and NO zip upload, because it
   only uses:
     - Node's built-in "crypto" module
     - @aws-sdk/client-dynamodb, which AWS already includes in the
       Node.js 22 Lambda runtime

   Runtime: Node.js 22.x
   Handler: index.handler
   ===================================================================== */

import crypto from "node:crypto";
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

/* ------------------------------------------------------------------ */
/* 1. CONFIGURATION - all of this comes from Lambda Environment Variables */
/* ------------------------------------------------------------------ */

const REGION = process.env.AWS_REGION;
const USER_POOL_ID = process.env.USER_POOL_ID;     // e.g. ap-south-1_AbC123
const APP_CLIENT_ID = process.env.APP_CLIENT_ID;   // e.g. 7hq2n...
const QR_SECRET = process.env.QR_SECRET;           // any long random string
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const T_USERS = process.env.TBL_USERS || "att_Users";
const T_CLASSES = process.env.TBL_CLASSES || "att_Classes";
const T_ENROLL = process.env.TBL_ENROLLMENTS || "att_Enrollments";
const T_SESSIONS = process.env.TBL_SESSIONS || "att_Sessions";
const T_ATT = process.env.TBL_ATTENDANCE || "att_Attendance";

// How long one QR code stays valid, in seconds.
const QR_WINDOW_SECONDS = 10;

const ddb = new DynamoDBClient({ region: REGION });

/* ------------------------------------------------------------------ */
/* 2. TINY DYNAMODB HELPERS                                            */
/*    DynamoDB stores data in a special shape: {"name":{"S":"Saurav"}} */
/*    These two functions convert normal JavaScript objects to that    */
/*    shape and back, so the rest of the code stays easy to read.      */
/* ------------------------------------------------------------------ */

function toAttr(value) {
  if (value === null || value === undefined) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(toAttr) };
  if (typeof value === "object") return { M: toItem(value) };
  return { S: String(value) };
}

function toItem(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = toAttr(v);
  }
  return out;
}

function fromAttr(attr) {
  if (!attr) return undefined;
  if ("S" in attr) return attr.S;
  if ("N" in attr) return Number(attr.N);
  if ("BOOL" in attr) return attr.BOOL;
  if ("NULL" in attr) return null;
  if ("L" in attr) return attr.L.map(fromAttr);
  if ("M" in attr) return fromItem(attr.M);
  return undefined;
}

function fromItem(item) {
  if (!item) return null;
  const out = {};
  for (const [k, v] of Object.entries(item)) out[k] = fromAttr(v);
  return out;
}

/* ------------------------------------------------------------------ */
/* 3. LOGIN CHECK (JWT VERIFICATION)                                   */
/*                                                                     */
/*    When a user logs in, Cognito gives their browser a signed "ID    */
/*    token". The browser sends it with every request. We must NEVER   */
/*    trust it blindly - we verify Cognito's digital signature here,   */
/*    on the server. This is what stops someone typing a fake token.   */
/* ------------------------------------------------------------------ */

let jwksCache = null; // downloaded once, then kept in memory

async function getJwks() {
  if (jwksCache) return jwksCache;
  const url =
    `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}/.well-known/jwks.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Could not download Cognito public keys");
  const data = await res.json();
  jwksCache = data.keys;
  return jwksCache;
}

function b64urlToBuffer(str) {
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

async function verifyIdToken(token) {
  if (!token) throw new HttpError(401, "You are not logged in.");

  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "Login token is malformed.");

  const header = JSON.parse(b64urlToBuffer(parts[0]).toString("utf8"));
  const payload = JSON.parse(b64urlToBuffer(parts[1]).toString("utf8"));

  // Find the public key Cognito used to sign this token
  const keys = await getJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new HttpError(401, "Unknown signing key.");

  // Check the signature really came from our Cognito user pool
  const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const ok = crypto.verify(
    "RSA-SHA256",
    Buffer.from(parts[0] + "." + parts[1]),
    publicKey,
    b64urlToBuffer(parts[2])
  );
  if (!ok) throw new HttpError(401, "Login token signature is invalid.");

  // Check the token is not expired and is really meant for our app
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new HttpError(401, "Login expired. Please log in again.");
  if (payload.token_use !== "id") throw new HttpError(401, "Wrong token type.");
  if (payload.aud !== APP_CLIENT_ID) throw new HttpError(401, "Token is for another app.");
  if (payload.iss !== `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`)
    throw new HttpError(401, "Token is from another user pool.");

  const groups = payload["cognito:groups"] || [];
  let role = "student";
  if (groups.includes("Admin")) role = "admin";
  else if (groups.includes("Teacher")) role = "teacher";

  return {
    userId: payload.sub,
    email: payload.email,
    name: payload.name || payload.email,
    role,
  };
}

/* ------------------------------------------------------------------ */
/* 4. THE ROTATING QR CODE                                             */
/*                                                                     */
/*    We do NOT store QR images anywhere. We build a short signed text */
/*    code that is only valid for 10 seconds, exactly like a Google    */
/*    Authenticator number. The browser turns that text into a QR      */
/*    picture. A screenshot forwarded to an absent friend is useless   */
/*    by the time it arrives.                                          */
/* ------------------------------------------------------------------ */

function currentWindow() {
  return Math.floor(Date.now() / (QR_WINDOW_SECONDS * 1000));
}

function sign(text) {
  return crypto
    .createHmac("sha256", QR_SECRET)
    .update(text)
    .digest("base64url")
    .slice(0, 20);
}

function makeQrToken(sessionId) {
  const body = `${sessionId}.${currentWindow()}`;
  return `${body}.${sign(body)}`;
}

function readQrToken(token) {
  const bits = String(token || "").split(".");
  if (bits.length !== 3) throw new HttpError(400, "This QR code is not valid.");

  const [sessionId, windowStr, signature] = bits;
  const body = `${sessionId}.${windowStr}`;

  // Was this code really made by us? (stops hand-made fake QR codes)
  if (sign(body) !== signature) throw new HttpError(400, "This QR code is not valid.");

  // Is it still fresh? We allow 1 window either side for slow cameras
  // and small clock differences, so real validity is about 20 seconds.
  const diff = Math.abs(currentWindow() - Number(windowStr));
  if (!Number.isFinite(diff) || diff > 1)
    throw new HttpError(410, "This QR code has expired. Please scan the new one on screen.");

  return sessionId;
}

/* ------------------------------------------------------------------ */
/* 5. SMALL UTILITIES                                                  */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function joinCode() {
  // 6 characters, no confusing 0/O or 1/I
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

function reply(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

function requireTeacher(user) {
  if (user.role !== "teacher" && user.role !== "admin")
    throw new HttpError(403, "Only a teacher can do this.");
}

/* ------------------------------------------------------------------ */
/* 6. DATABASE ACCESS FUNCTIONS                                        */
/* ------------------------------------------------------------------ */

async function saveUserProfile(user) {
  await ddb.send(new UpdateItemCommand({
    TableName: T_USERS,
    Key: toItem({ userId: user.userId }),
    UpdateExpression: "SET email = :e, #n = :n, #r = :r, lastSeen = :t",
    ExpressionAttributeNames: { "#n": "name", "#r": "role" },
    ExpressionAttributeValues: toItem({
      ":e": String(user.email || "").toLowerCase().trim(),
      ":n": user.name, ":r": user.role, ":t": Date.now(),
    }),
  }));
}

async function findUserByEmail(email) {
  const r = await ddb.send(new QueryCommand({
    TableName: T_USERS,
    IndexName: "email-index",
    KeyConditionExpression: "email = :e",
    ExpressionAttributeValues: toItem({ ":e": email.toLowerCase().trim() }),
    Limit: 1,
  }));
  return r.Items?.length ? fromItem(r.Items[0]) : null;
}

async function getClass(classId) {
  const r = await ddb.send(new GetItemCommand({
    TableName: T_CLASSES, Key: toItem({ classId }),
  }));
  const c = fromItem(r.Item);
  if (!c) throw new HttpError(404, "Class not found.");
  return c;
}

async function getSession(sessionId) {
  const r = await ddb.send(new GetItemCommand({
    TableName: T_SESSIONS, Key: toItem({ sessionId }),
  }));
  const s = fromItem(r.Item);
  if (!s) throw new HttpError(404, "Attendance session not found.");
  return s;
}

async function sessionsOfClass(classId) {
  const r = await ddb.send(new ScanCommand({
    TableName: T_SESSIONS,
    FilterExpression: "classId = :c",
    ExpressionAttributeValues: toItem({ ":c": classId }),
  }));
  return (r.Items || []).map(fromItem).sort((a, b) => b.startedAt - a.startedAt);
}

async function isEnrolled(classId, studentId) {
  const r = await ddb.send(new GetItemCommand({
    TableName: T_ENROLL, Key: toItem({ classId, studentId }),
  }));
  return !!r.Item;
}

/* ------------------------------------------------------------------ */
/* 7. THE ROUTES - one function per thing the app can do               */
/* ------------------------------------------------------------------ */

const routes = {

  /* ---------- Who am I? Also saves the profile on first login ------ */
  "GET /api/me": async (user) => {
    await saveUserProfile(user);
    return { user };
  },

  /* ---------- TEACHER: create a class ------------------------------ */
  "POST /api/classes": async (user, body) => {
    requireTeacher(user);
    if (!body.name) throw new HttpError(400, "Please enter a class name.");

    const item = {
      classId: newId("cls"),
      name: String(body.name).trim(),
      subject: String(body.subject || "").trim(),
      teacherId: user.userId,
      teacherName: user.name,
      joinCode: joinCode(),
      createdAt: Date.now(),
    };
    await ddb.send(new PutItemCommand({ TableName: T_CLASSES, Item: toItem(item) }));
    return { class: item };
  },

  /* ---------- List classes (different answer for each role) -------- */
  "GET /api/classes": async (user) => {
    if (user.role === "teacher" || user.role === "admin") {
      const r = await ddb.send(new ScanCommand({
        TableName: T_CLASSES,
        ...(user.role === "teacher" ? {
          FilterExpression: "teacherId = :t",
          ExpressionAttributeValues: toItem({ ":t": user.userId }),
        } : {}),
      }));
      return { classes: (r.Items || []).map(fromItem) };
    }

    // Student: find every class they are enrolled in
    const e = await ddb.send(new QueryCommand({
      TableName: T_ENROLL,
      IndexName: "student-index",
      KeyConditionExpression: "studentId = :s",
      ExpressionAttributeValues: toItem({ ":s": user.userId }),
    }));
    const classes = [];
    for (const row of (e.Items || []).map(fromItem)) {
      try { classes.push(await getClass(row.classId)); } catch { /* deleted class */ }
    }
    return { classes };
  },

  /* ---------- TEACHER: add a student to a class by email ----------- */
  "POST /api/enrollments": async (user, body) => {
    requireTeacher(user);
    const cls = await getClass(body.classId);
    if (user.role === "teacher" && cls.teacherId !== user.userId)
      throw new HttpError(403, "This is not your class.");

    const student = await findUserByEmail(body.email || "");
    if (!student)
      throw new HttpError(404, "No student found with that email. Ask them to register and log in once first.");

    await ddb.send(new PutItemCommand({
      TableName: T_ENROLL,
      Item: toItem({
        classId: cls.classId,
        studentId: student.userId,
        studentName: student.name,
        studentEmail: student.email,
        enrolledAt: Date.now(),
      }),
    }));
    return { ok: true, student: { name: student.name, email: student.email } };
  },

  /* ---------- STUDENT: join a class using the 6 letter code -------- */
  "POST /api/enrollments/join": async (user, body) => {
    const code = String(body.joinCode || "").toUpperCase().trim();
    const r = await ddb.send(new ScanCommand({
      TableName: T_CLASSES,
      FilterExpression: "joinCode = :j",
      ExpressionAttributeValues: toItem({ ":j": code }),
    }));
    if (!r.Items?.length) throw new HttpError(404, "No class found with that code.");

    const cls = fromItem(r.Items[0]);
    await ddb.send(new PutItemCommand({
      TableName: T_ENROLL,
      Item: toItem({
        classId: cls.classId,
        studentId: user.userId,
        studentName: user.name,
        studentEmail: user.email,
        enrolledAt: Date.now(),
      }),
    }));
    return { ok: true, class: cls };
  },

  /* ---------- TEACHER: see the student list of a class ------------- */
  "GET /api/enrollments": async (user, body, query) => {
    requireTeacher(user);
    const r = await ddb.send(new QueryCommand({
      TableName: T_ENROLL,
      KeyConditionExpression: "classId = :c",
      ExpressionAttributeValues: toItem({ ":c": query.classId }),
    }));
    return { students: (r.Items || []).map(fromItem) };
  },

  /* ---------- TEACHER: start an attendance session ----------------- */
  "POST /api/sessions": async (user, body) => {
    requireTeacher(user);
    const cls = await getClass(body.classId);
    if (user.role === "teacher" && cls.teacherId !== user.userId)
      throw new HttpError(403, "This is not your class.");

    const minutes = Math.min(Math.max(Number(body.minutes) || 15, 1), 240);
    const item = {
      sessionId: newId("ses"),
      classId: cls.classId,
      className: cls.name,
      teacherId: user.userId,
      status: "OPEN",
      startedAt: Date.now(),
      expiresAt: Date.now() + minutes * 60 * 1000,
      minutes,
    };
    await ddb.send(new PutItemCommand({ TableName: T_SESSIONS, Item: toItem(item) }));
    return { session: item };
  },

  /* ---------- TEACHER: close a session ----------------------------- */
  "POST /api/sessions/close": async (user, body) => {
    requireTeacher(user);
    const s = await getSession(body.sessionId);
    if (user.role === "teacher" && s.teacherId !== user.userId)
      throw new HttpError(403, "This is not your session.");

    await ddb.send(new UpdateItemCommand({
      TableName: T_SESSIONS,
      Key: toItem({ sessionId: s.sessionId }),
      UpdateExpression: "SET #st = :c, closedAt = :t",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: toItem({ ":c": "CLOSED", ":t": Date.now() }),
    }));
    return { ok: true };
  },

  /* ---------- TEACHER: get a fresh QR code (called every 10s) ------ */
  "GET /api/sessions/qr": async (user, body, query) => {
    requireTeacher(user);
    const s = await getSession(query.sessionId);
    if (user.role === "teacher" && s.teacherId !== user.userId)
      throw new HttpError(403, "This is not your session.");
    if (s.status !== "OPEN") throw new HttpError(400, "This session is closed.");
    if (Date.now() > s.expiresAt) throw new HttpError(400, "This session has ended.");

    return {
      token: makeQrToken(s.sessionId),
      validForSeconds: QR_WINDOW_SECONDS,
      sessionEndsAt: s.expiresAt,
    };
  },

  /* ---------- TEACHER: live list of who has scanned ---------------- */
  "GET /api/sessions/live": async (user, body, query) => {
    requireTeacher(user);
    const s = await getSession(query.sessionId);

    const present = await ddb.send(new QueryCommand({
      TableName: T_ATT,
      KeyConditionExpression: "sessionId = :s",
      ExpressionAttributeValues: toItem({ ":s": s.sessionId }),
    }));
    const roster = await ddb.send(new QueryCommand({
      TableName: T_ENROLL,
      KeyConditionExpression: "classId = :c",
      ExpressionAttributeValues: toItem({ ":c": s.classId }),
    }));

    const presentList = (present.Items || []).map(fromItem)
      .sort((a, b) => b.markedAt - a.markedAt);
    const presentIds = new Set(presentList.map((p) => p.studentId));
    const absentList = (roster.Items || []).map(fromItem)
      .filter((r) => !presentIds.has(r.studentId));

    return { session: s, present: presentList, absent: absentList };
  },

  /* ---------- Session history for a class -------------------------- */
  "GET /api/sessions/history": async (user, body, query) => {
    requireTeacher(user);
    return { sessions: await sessionsOfClass(query.classId) };
  },

  /* ================================================================ */
  /* THE MOST IMPORTANT ROUTE: STUDENT MARKS ATTENDANCE               */
  /* ================================================================ */
  "POST /api/attendance/mark": async (user, body) => {

    // CHECK 1 + 2: is the QR really ours, and is it still fresh?
    const sessionId = readQrToken(body.token);

    // CHECK 3: does the session exist and is it still open?
    const s = await getSession(sessionId);
    if (s.status !== "OPEN")
      throw new HttpError(400, "This attendance session is closed.");
    if (Date.now() > s.expiresAt)
      throw new HttpError(400, "This attendance session has ended.");

    // CHECK 4: is this student actually in this class?
    if (!(await isEnrolled(s.classId, user.userId)))
      throw new HttpError(403, "You are not enrolled in this class.");

    // CHECK 5: has this student already been marked? The database
    // itself refuses to write a second record, so two phones tapping
    // at the exact same moment still cannot create a duplicate.
    try {
      await ddb.send(new PutItemCommand({
        TableName: T_ATT,
        Item: toItem({
          sessionId: s.sessionId,
          studentId: user.userId,
          studentName: user.name,
          studentEmail: user.email,
          classId: s.classId,
          className: s.className,
          markedAt: Date.now(),
          method: "QR",
        }),
        ConditionExpression: "attribute_not_exists(sessionId)",
      }));
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException")
        return { ok: true, alreadyMarked: true, message: "You are already marked present." };
      throw err;
    }

    return { ok: true, alreadyMarked: false, className: s.className,
             message: "Attendance marked successfully." };
  },

  /* ---------- TEACHER: mark someone present by hand ---------------- */
  "POST /api/attendance/manual": async (user, body) => {
    requireTeacher(user);
    const s = await getSession(body.sessionId);
    const student = await findUserByEmail(body.email || "");
    if (!student) throw new HttpError(404, "No student found with that email.");

    await ddb.send(new PutItemCommand({
      TableName: T_ATT,
      Item: toItem({
        sessionId: s.sessionId,
        studentId: student.userId,
        studentName: student.name,
        studentEmail: student.email,
        classId: s.classId,
        className: s.className,
        markedAt: Date.now(),
        method: "MANUAL",
        markedBy: user.email,
      }),
    }));
    return { ok: true };
  },

  /* ---------- STUDENT: my history and my percentage ---------------- */
  "GET /api/attendance/me": async (user) => {
    const rows = await ddb.send(new QueryCommand({
      TableName: T_ATT,
      IndexName: "student-index",
      KeyConditionExpression: "studentId = :s",
      ExpressionAttributeValues: toItem({ ":s": user.userId }),
    }));
    const records = (rows.Items || []).map(fromItem).sort((a, b) => b.markedAt - a.markedAt);

    // Work out the percentage for each class the student belongs to
    const enrolled = await ddb.send(new QueryCommand({
      TableName: T_ENROLL,
      IndexName: "student-index",
      KeyConditionExpression: "studentId = :s",
      ExpressionAttributeValues: toItem({ ":s": user.userId }),
    }));

    const summary = [];
    for (const row of (enrolled.Items || []).map(fromItem)) {
      const sessions = await sessionsOfClass(row.classId);
      const attended = records.filter((r) => r.classId === row.classId).length;
      let cls = null;
      try { cls = await getClass(row.classId); } catch { continue; }
      summary.push({
        classId: row.classId,
        className: cls.name,
        totalSessions: sessions.length,
        attended,
        percentage: sessions.length ? Math.round((attended / sessions.length) * 100) : 0,
      });
    }
    return { records, summary };
  },

  /* ---------- TEACHER: percentage report for a whole class --------- */
  "GET /api/reports/class": async (user, body, query) => {
    requireTeacher(user);
    const classId = query.classId;
    const sessions = await sessionsOfClass(classId);

    const roster = await ddb.send(new QueryCommand({
      TableName: T_ENROLL,
      KeyConditionExpression: "classId = :c",
      ExpressionAttributeValues: toItem({ ":c": classId }),
    }));

    // Collect every attendance record for every session of this class
    const attendedBy = {};
    for (const s of sessions) {
      const r = await ddb.send(new QueryCommand({
        TableName: T_ATT,
        KeyConditionExpression: "sessionId = :s",
        ExpressionAttributeValues: toItem({ ":s": s.sessionId }),
      }));
      for (const rec of (r.Items || []).map(fromItem)) {
        attendedBy[rec.studentId] = (attendedBy[rec.studentId] || 0) + 1;
      }
    }

    const report = (roster.Items || []).map(fromItem).map((st) => {
      const attended = attendedBy[st.studentId] || 0;
      return {
        studentName: st.studentName,
        studentEmail: st.studentEmail,
        attended,
        totalSessions: sessions.length,
        percentage: sessions.length ? Math.round((attended / sessions.length) * 100) : 0,
      };
    }).sort((a, b) => a.studentName.localeCompare(b.studentName));

    return { totalSessions: sessions.length, report };
  },
};

/* ------------------------------------------------------------------ */
/* 8. THE HANDLER - the first thing AWS runs for every request         */
/* ------------------------------------------------------------------ */

export const handler = async (event) => {
  // Browsers send an OPTIONS "permission question" before a real
  // request. We answer it immediately.
  const method = event.requestContext?.http?.method || "GET";
  if (method === "OPTIONS") return reply(200, { ok: true });

  const path = (event.rawPath || "/").replace(/\/+$/, "") || "/";
  const query = event.queryStringParameters || {};

  if (path === "/" || path === "/api/health")
    return reply(200, { ok: true, service: "QR Attendance API", madeBy: "Saurav" });

  try {
    const routeKey = `${method} ${path}`;
    const fn = routes[routeKey];
    if (!fn) throw new HttpError(404, `No such route: ${routeKey}`);

    // Every route below this line needs a valid login
    const auth = event.headers?.authorization || event.headers?.Authorization || "";
    const user = await verifyIdToken(auth.replace(/^Bearer\s+/i, ""));

    let body = {};
    if (event.body) {
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body;
      body = JSON.parse(raw || "{}");
    }

    const result = await fn(user, body, query);
    return reply(200, result);

  } catch (err) {
    console.error("ERROR:", err);   // this shows up in CloudWatch Logs
    if (err instanceof HttpError) return reply(err.status, { error: err.message });
    return reply(500, { error: "Something went wrong on the server." });
  }
};
