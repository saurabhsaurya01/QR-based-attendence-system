# Viva Questions & Answers

**QR Code Based Attendance System — Made by Saurav**

Read this the night before. The answers are written the way you would actually say them out loud.

---

### 1. Why did you use serverless instead of a normal server?

A normal server runs 24 hours a day whether anyone uses it or not, so you pay for idle time and you have to patch and secure it yourself. Lambda runs only when a request arrives. For an attendance system that is busy for five minutes a day, that is the right shape — and it fits inside AWS's always-free allowance of one million requests a month.

---

### 2. How does your system stop proxy attendance?

Four ways, layered.

First, the QR code on the teacher's screen changes every ten seconds, so a screenshot forwarded to a friend has expired before it arrives. Second, the code is signed with a secret key that only my Lambda function knows, so nobody can make a fake one. Third, the student has to be logged in with their own Cognito account — the code alone marks nobody present. Fourth, the system checks the student is actually enrolled in that class.

I should be honest about the limit: a student in the room could still relay a live code over a video call within that twenty-second window. Fixing that fully needs a GPS or Bluetooth proximity check, which is the next thing I would add.

---

### 3. How exactly does the rotating QR code work?

It is the same idea as Google Authenticator. I take the session ID and the current ten-second time window, join them, and sign that with HMAC-SHA256 using a secret stored in a Lambda environment variable. The result is a short piece of text. The browser turns that text into a QR picture.

When a scan comes in, Lambda recomputes the signature. If it does not match, the code is fake. Then it checks the time window is still current. I allow one window either side for slow cameras and clock differences, so real validity is about twenty seconds.

The QR image is never generated on AWS and never stored anywhere, which is why the system costs nothing in storage.

---

### 4. How do you prevent duplicate attendance?

I did not solve it in application code, I solved it in the database design. The Attendance table's primary key is the *pair* of session ID and student ID. That pair can physically exist only once. On top of that the write carries a condition — `attribute_not_exists(sessionId)` — so DynamoDB rejects the second write itself.

That means even if two phones send the request in the same millisecond, only one row can be created. If it had been an `if (alreadyExists)` check in my code, there is a race condition where both requests read "not present" before either writes.

---

### 5. What is Cognito actually doing?

It stores users, enforces password rules, sends the email confirmation code, and issues a signed JSON Web Token when someone logs in. My website keeps that token and attaches it to every request.

The important part is that I do not trust the token blindly. Lambda downloads Cognito's public keys and verifies the RSA signature, the expiry time, the audience and the issuer on every single request. If any of those fail, the request is rejected with a 401.

---

### 6. Where is the user's role stored, and could a student fake being a teacher?

The role is a Cognito group — Teacher or Admin — and the group name travels inside the signed token as the `cognito:groups` claim. Because the token is signed by Cognito and verified by my Lambda, changing it would break the signature.

A student could edit their browser's JavaScript to *show* the teacher screen, but every teacher action calls a server route that checks the role again. They would just get "Only a teacher can do this."

---

### 7. Why did you not use API Gateway?

Cost, and I checked rather than assumed. API Gateway's free allowance of one million calls is a twelve-month offer, and current pricing guidance says it applies only to accounts created before July 2025 — newer accounts draw down credits and then pay a dollar per million HTTP API requests.

A Lambda Function URL gives the same HTTPS endpoint at no additional charge — you pay only the normal Lambda cost, which my project stays inside. I would use API Gateway if I needed rate limiting, API keys, or a custom authorizer, but for one small API it is a service and a charge I do not need.

---

### 8. Function URL auth type is NONE. Is that not insecure?

It means AWS does not check the caller for me. My own code does, on every request, before touching any data. So the endpoint is reachable by anyone, but useless without a valid Cognito token.

That is a deliberate trade: I moved the authentication check into my own code so I do not have to pay for API Gateway. It is the same check either way.

---

### 9. Why DynamoDB and not MySQL?

Three reasons. There is no server to run or pay for. The free allowance of twenty-five gigabytes is permanent rather than a trial. And the key design does the duplicate prevention for me.

The trade-off is that DynamoDB cannot do joins, so I do some work in code that SQL would do in a query — for example calculating the attendance percentage. At the size of one college that is fine.

---

### 10. What is a GSI and why do you need two?

A Global Secondary Index is a second way to look up the same data. My Enrollments table is keyed by class, so "who is in this class" is fast — but "which classes is this student in" would need a full scan. The GSI on studentId makes that fast too.

The thing to watch is cost: every GSI needs its own provisioned capacity, and it comes out of the same twenty-five free units as the tables. I budgeted twenty read and twenty write in total across five tables and two indexes, leaving five spare.

---

### 11. Why do you need CloudFront? Could you not just use S3?

S3 static website hosting only serves plain HTTP. Phone browsers refuse to give a website access to the camera unless the page is on HTTPS, so without CloudFront the scanner simply would not open. CloudFront gives me a free HTTPS address and certificate without buying a domain.

It also caches the files at edge locations so the page loads quickly, and its always-free tier covers a terabyte of transfer a month.

---

### 12. What did this cost you?

Zero. Everything is inside AWS's always-free allowances — Lambda, DynamoDB, Cognito and CloudFront all have permanent monthly limits that this project uses a tiny fraction of.

I also set a one-dollar budget alert before creating a single resource, and I deliberately avoided the services that generate surprise bills — NAT Gateway, RDS, Elastic IPs, Route 53 and SMS.

One thing I would flag: a new AWS Free plan account closes automatically after six months or when the signup credits run out. So this deployment has a shelf life unless I upgrade the account.

---

### 13. What would you do differently or add next?

Three things, in order.

A location check — have the browser send GPS coordinates and reject scans more than a hundred metres from campus. I left a hook for it. It would close the video-call relay gap.

Second, an offline queue, so if the college wifi drops mid-scan the phone retries when it reconnects.

Third, at real scale I would move to a single-table DynamoDB design and add API Gateway with rate limiting, because right now nothing stops someone hammering my Lambda.

---

### 14. Walk me through what happens when a student scans.

The camera reads the QR and gets a short text code. The browser sends that code to my Lambda Function URL with the student's login token in the Authorization header.

Lambda then runs six checks. Is the login token really signed by my Cognito pool. Was this QR code really made by me — I recompute the HMAC signature. Is the ten-second window still current. Is the session still open and not past its end time. Is this student enrolled in that class. And finally, does an attendance row already exist for them.

If all six pass, it writes one row to the Attendance table and returns success. The phone shows "Attendance marked successfully" and the teacher's screen picks up the new name within four seconds.

Every one of those checks is on the server. Nothing the phone sends is trusted.

---

### 15. Show me it failing.

*(Have this ready — it is the strongest thirty seconds of the demo.)*

Screenshot the QR. Wait twenty-five seconds. Scan the screenshot. The screen says **"This QR code has expired."**

Then scan the live code twice. The second time says **"You are already marked present"** and the attendance count does not move.

---

**Made by Saurav**
