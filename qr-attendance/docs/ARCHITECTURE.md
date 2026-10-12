# Architecture & Design

**QR Code Based Attendance System — Made by Saurav**

---

## 1. System architecture

```
                      STUDENT PHONE          TEACHER LAPTOP
                            │                      │
                            └──────────┬───────────┘
                                       │ HTTPS
                                       ▼
                    ┌──────────────────────────────────┐
                    │          CloudFront              │
                    │  free https + free certificate   │
                    │  (camera access needs https)     │
                    └──────────────────────────────────┘
                                       │
                                       ▼
                    ┌──────────────────────────────────┐
                    │           S3 bucket              │
                    │  index.html · teacher.html       │
                    │  student.html · assets/          │
                    │  private, read only by CloudFront│
                    └──────────────────────────────────┘

   The browser also makes two kinds of call on its own:

   ┌── LOGIN ─────────────┐        ┌── EVERYTHING ELSE ──────────────┐
   │                      │        │                                  │
   ▼                      │        ▼                                  │
┌──────────────┐   ID token│   ┌──────────────────────┐               │
│   Cognito    │───────────┘   │ Lambda Function URL  │               │
│  user pool   │               │  qr-attendance-api   │               │
│ Student /    │               │  Node.js 22, arm64   │               │
│ Teacher /    │               └──────────────────────┘               │
│ Admin groups │                          │                           │
└──────────────┘                          ▼                           │
                              ┌──────────────────────┐                │
                              │      DynamoDB        │                │
                              │  att_Users           │                │
                              │  att_Classes         │                │
                              │  att_Enrollments     │                │
                              │  att_Sessions        │                │
                              │  att_Attendance      │                │
                              └──────────────────────┘                │
                                                                       │
   IAM ............ decides what the Lambda may touch ─────────────────┘
   CloudWatch ..... stores every error the Lambda prints
   AWS Budgets .... emails you if anything ever costs ₹1
```

---

## 2. Why each service

| Service | Why it is here | What we rejected instead |
|---|---|---|
| **S3** | Cheapest storage for a static site | EC2 — a server running 24×7 that we would pay for |
| **CloudFront** | Free HTTPS. Phone cameras will not work without it | S3 website hosting — HTTP only |
| **Cognito** | Passwords, email confirmation, reset, secure tokens | Hand-rolled auth — the usual source of security holes |
| **Lambda** | Runs only on request, always-free allowance | A running Node server |
| **Function URL** | HTTPS endpoint with no extra charge | API Gateway — its free tier is a 12-month offer |
| **DynamoDB** | No server, always-free allowance, key design blocks duplicates | RDS/MySQL — a database instance billing by the hour |
| **IAM** | Lambda can touch five tables and nothing else | A wide-open role |
| **CloudWatch** | Where errors go so you can debug | Guessing |

---

## 3. Database design

### att_Users
| Field | Type | Notes |
|---|---|---|
| userId | String | **Partition key.** The `sub` from the Cognito token |
| email | String | GSI `email-index` so a teacher can add a student by email |
| name | String | |
| role | String | student / teacher / admin |
| lastSeen | Number | |

### att_Classes
| Field | Type | Notes |
|---|---|---|
| classId | String | **Partition key** |
| name, subject | String | |
| teacherId, teacherName | String | |
| joinCode | String | 6 characters, no confusing 0/O or 1/I |
| createdAt | Number | |

### att_Enrollments
| Field | Type | Notes |
|---|---|---|
| classId | String | **Partition key** |
| studentId | String | **Sort key** |
| studentName, studentEmail | String | |

GSI `student-index` on studentId, so a student can list their own classes.

### att_Sessions
| Field | Type | Notes |
|---|---|---|
| sessionId | String | **Partition key** |
| classId, className, teacherId | String | |
| status | String | OPEN or CLOSED |
| startedAt, expiresAt | Number | milliseconds |

### att_Attendance
| Field | Type | Notes |
|---|---|---|
| sessionId | String | **Partition key** |
| studentId | String | **Sort key** |
| studentName, studentEmail, classId, className | String | |
| markedAt | Number | |
| method | String | QR or MANUAL |

GSI `student-index` on studentId + markedAt, for a student's history.

**The duplicate-prevention design.** Because the primary key is the *pair* `sessionId + studentId`, that pair can exist at most once. The write also carries `ConditionExpression: attribute_not_exists(sessionId)`, so DynamoDB itself rejects the second attempt. Two phones tapping at the identical millisecond still cannot create two rows.

### Free-tier capacity budget

| Table / index | Read | Write |
|---|---|---|
| att_Users | 2 | 2 |
| att_Users / email-index | 2 | 2 |
| att_Classes | 2 | 2 |
| att_Enrollments | 3 | 3 |
| att_Enrollments / student-index | 2 | 2 |
| att_Sessions | 3 | 3 |
| att_Attendance | 3 | 3 |
| att_Attendance / student-index | 3 | 3 |
| **Total** | **20** | **20** |
| Free allowance | 25 | 25 |

All tables are **provisioned capacity, Standard table class** — the only combination the free allowance covers.

---

## 4. How the rotating QR code works

The QR picture is never made on AWS and never stored anywhere. It is drawn in the browser from a short piece of text.

```
window   = floor(current time in ms / 10000)      → changes every 10 seconds
body     = sessionId + "." + window
signature= HMAC-SHA256(body, QR_SECRET) shortened
token    = body + "." + signature
```

`QR_SECRET` lives only in a Lambda environment variable.

When a scan arrives, Lambda:

1. Recomputes the signature. If it does not match, the QR was not made by us → rejected.
2. Compares the window to the current one. More than one window apart → expired.

One window either side is allowed, so real validity is about 20 seconds. That is enough for a slow camera and a phone with a slightly wrong clock, and far too short to forward a screenshot to a friend across campus.

This is the same idea as a Google Authenticator number.

---

## 5. Security model

| Requirement | How it is met |
|---|---|
| Authentication | Cognito issues a signed ID token. Lambda downloads Cognito's public keys and verifies the RSA signature, expiry, audience and issuer on every single request. |
| Authorization | The role comes from the `cognito:groups` claim **inside the signed token** — the browser cannot fake it. Teacher-only routes call `requireTeacher()`. |
| Unique session | Every session gets a random ID. A student can only be marked present against a session that exists and is OPEN. |
| Session expiry | Two layers: the 10-second QR window, and the session's own `expiresAt`. |
| Duplicate prevention | Composite primary key plus a conditional write. Enforced by the database, not by application logic. |
| Server-side validation | All six checks run inside Lambda. Nothing sent by the phone is trusted. |
| Secure database access | An IAM inline policy grants five specific table ARNs and five actions. Nothing else in the account is reachable. |
| QR sharing / reuse | The signed, rotating token makes a forwarded screenshot useless within seconds. Enrolment is also checked, so a student from another class cannot mark themselves present. |

### Honest limitations

Worth saying yourself before the examiner says it:

- A student **inside the room** can still relay a live code to a friend over a video call within the 20-second window. Fixing that properly needs a location check or Bluetooth proximity. The code has a place to add a GPS check.
- Function URL auth type is NONE, so anyone can reach the endpoint — but without a valid Cognito token every request is rejected with 401. Authentication is done by our code, deliberately, so we do not pay for API Gateway.
- Two students could share one login. That is a password problem, not a QR problem, and no attendance system solves it without biometrics.

---

## 6. Cost model

| Service | Free allowance | What this project uses |
|---|---|---|
| Lambda | 1M requests + 400,000 GB-s per month, always free | ~50,000 requests total |
| DynamoDB | 25 GB, 25 RCU, 25 WCU per month, always free | ~1 MB, 20 RCU/WCU |
| Cognito | 10,000 monthly active users, does not expire | ~5 |
| CloudFront | 1 TB out + 10M requests per month, always free | under 1 GB |
| S3 | 5 GB (disputed for new accounts) | ~100 KB — rounds to ₹0.00 either way |
| CloudWatch Logs | 5 GB ingest per month | a few MB |
| Function URL | no additional charge | — |
| IAM, Budgets (first 2) | free | — |

**Account-level warning.** A new AWS account on the Free plan ends at six months or when the $100 + $100 credits run out, whichever comes first — and then closes automatically, with 90 days to recover data. Note your signup date.

---

**Made by Saurav**
