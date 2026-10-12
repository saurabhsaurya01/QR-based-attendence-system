/* ===================================================================
   QR ATTENDANCE SYSTEM - CONFIGURATION
   Made by Saurav

   THIS IS THE ONLY FILE YOU EDIT after you build your AWS resources.

   Leave it exactly as it is right now and the app runs in DEMO MODE:
   everything works in your browser with fake data, no AWS needed.
   Great for testing on your laptop before you touch AWS.

   Fill in the three values below and the app instantly switches to
   REAL AWS MODE - Cognito for login, Lambda for the backend,
   DynamoDB for the data.
   =================================================================== */

window.CONFIG = {

  // Step 4 of the guide gives you these two (Amazon Cognito)
  REGION: "",          // example: "ap-south-1"
  USER_POOL_ID: "",    // example: "ap-south-1_A1b2C3d4E"
  APP_CLIENT_ID: "",   // example: "7hq2n8k1v3m5p9r2s4t6u8w0x2"

  // Step 6 of the guide gives you this (Lambda Function URL)
  // Paste it WITHOUT the slash at the end.
  API_URL: "",         // example: "https://abc123xyz.lambda-url.ap-south-1.on.aws"

};
