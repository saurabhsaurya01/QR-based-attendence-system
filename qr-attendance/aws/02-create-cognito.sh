#!/bin/bash
# ===================================================================
# QR ATTENDANCE SYSTEM - create the login system (Amazon Cognito)
# Made by Saurav
#
# Paste this whole file into AWS CloudShell and press Enter.
# At the end it prints the two values you paste into config.js.
#
# COST: Cognito's free allowance covers 10,000 monthly active users.
#       You will have about 5. Nothing here can charge you.
#       We do NOT enable SMS messages anywhere - SMS costs real money.
# ===================================================================

set -e

echo "Creating the user pool..."
POOL_ID=$(aws cognito-idp create-user-pool \
  --pool-name qr-attendance-pool \
  --username-attributes email \
  --auto-verified-attributes email \
  --mfa-configuration OFF \
  --policies '{"PasswordPolicy":{
        "MinimumLength":8,
        "RequireUppercase":true,
        "RequireLowercase":true,
        "RequireNumbers":true,
        "RequireSymbols":true}}' \
  --schema '[{"Name":"name","AttributeDataType":"String","Mutable":true,"Required":true}]' \
  --query 'UserPool.Id' --output text)

echo "Creating the app client (this is what the website talks to)..."
CLIENT_ID=$(aws cognito-idp create-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-name qr-attendance-web \
  --no-generate-secret \
  --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH \
  --query 'UserPoolClient.ClientId' --output text)

echo "Creating the Teacher and Admin groups..."
aws cognito-idp create-group --user-pool-id "$POOL_ID" \
  --group-name Teacher --description "Can create classes and run sessions" >/dev/null
aws cognito-idp create-group --user-pool-id "$POOL_ID" \
  --group-name Admin --description "Can see every class" >/dev/null

echo ""
echo "==================================================="
echo " COPY THESE THREE LINES INTO frontend/assets/config.js"
echo "==================================================="
echo "  REGION:        \"$AWS_REGION\","
echo "  USER_POOL_ID:  \"$POOL_ID\","
echo "  APP_CLIENT_ID: \"$CLIENT_ID\","
echo "==================================================="
echo ""
echo "Anyone who registers is a STUDENT by default."
echo "To turn someone into a teacher, run this after they register:"
echo ""
echo "  aws cognito-idp admin-add-user-to-group \\"
echo "    --user-pool-id $POOL_ID \\"
echo "    --username their.email@college.edu \\"
echo "    --group-name Teacher"
echo ""
echo "Made by Saurav"
