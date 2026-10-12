# QR Code Based Attendance System

**Made by Saurav**

A working attendance system on Amazon Web Services. A student points their phone camera at a QR code on the teacher's screen and their attendance is recorded. The QR code changes every 10 seconds, so a screenshot forwarded to an absent friend is useless by the time it arrives.

Built to cost **₹0**.

---

## Try it right now — no AWS needed

1. Open `frontend/index.html` by double-clicking it
2. Sign in with **teacher@demo.com** / **Demo@1234**
3. Create a class, then start a session — watch the QR rotate
4. In another tab sign in with **student@demo.com** / **Demo@1234**, join the class with the code, and paste the QR text to mark attendance

An orange **DEMO MODE** bar tells you nothing is connected to AWS. All data lives in your browser.

> The camera scanner will not open from a double-clicked file — browsers only allow camera access over `https`. That works once the site is on CloudFront (Step 9 of the guide).

---

## Then build it on AWS

Open **`docs/SETUP-GUIDE.md`** and follow the twelve steps. About two hours from an empty screen to a live system.

The guide covers signing up for AWS, setting a ₹1 cost alarm before creating anything, building each service, testing each piece, fixing the errors you will hit, and deleting it all afterwards.

---

## What is in this folder

```
backend/
  index.mjs .................... the entire backend. Paste into AWS Lambda.
                                 Zero npm packages needed.

frontend/
  index.html ................... sign in and register
  teacher.html ................. classes, sessions, rotating QR, live list, reports
  student.html ................. join class, camera scanner, attendance history
  assets/config.js ............. THE ONLY FILE YOU EDIT
  assets/app.js ................ login, API calls, and a full offline demo backend
  assets/styles.css ............ the look

aws/
  01-create-tables.sh .......... creates the 5 DynamoDB tables, free-tier safe
  02-create-cognito.sh ......... creates the login system
  lambda-dynamodb-policy.json .. the exact permissions Lambda needs
  99-delete-everything.sh ...... removes everything after your demo

docs/
  SETUP-GUIDE.md ............... START HERE. Twelve steps, zero to working.
  ARCHITECTURE.md .............. diagrams, database design, security model
  VIVA-QUESTIONS.md ............ 15 likely examiner questions with answers
```

---

## Features

**Teacher / Admin**
- Sign in
- Create classes with an auto-generated 6-letter join code
- Add students by email, or let them join with the code
- Start an attendance session with a chosen expiry (5 to 60 minutes)
- Rotating QR code with a live countdown
- See who has scanned, live, as it happens
- Mark a student present manually if their phone is dead
- Close a session
- Session history per class
- Attendance percentage report, downloadable as CSV

**Student**
- Register with email confirmation
- Join a class with a code
- Scan the QR with the phone camera
- See "attendance marked" or a clear reason it failed
- Attendance history and percentage per class

**Security**
- Cognito login, with the token's signature verified on the server every request
- Roles from Cognito groups, checked server-side
- QR codes signed with a secret only Lambda knows
- 10-second QR expiry plus a session-level expiry
- Duplicate attendance blocked by the database key itself
- Enrolment checked before any attendance is recorded
- IAM policy restricting Lambda to five specific tables

---

## AWS services used

| Service | Job |
|---|---|
| S3 | stores the website files |
| CloudFront | free HTTPS — without it the phone camera will not open |
| Cognito | login, passwords, email confirmation, roles |
| Lambda | the whole backend, one function |
| DynamoDB | five tables |
| IAM | keeps Lambda locked to those five tables |
| CloudWatch | error logs |
| AWS Budgets | emails you if anything ever costs ₹1 |

Deliberately **not** used, because they cost money: API Gateway, EC2, RDS, NAT Gateway, Route 53, SNS/SMS, WAF.

---

## Cost

Everything sits inside AWS's always-free monthly allowances. Read `docs/ARCHITECTURE.md` section 6 for the numbers, and Step 11 of the setup guide for the list of things that would generate a bill.

**One warning worth repeating:** a new AWS account on the Free plan ends after six months or when the signup credits run out, whichever comes first — and then closes automatically. Note your signup date.

---

**Made by Saurav**
