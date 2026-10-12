#!/bin/bash
# ===================================================================
# QR ATTENDANCE SYSTEM - DELETE EVERYTHING
# Made by Saurav
#
# Run this in AWS CloudShell after your demo is finished.
# It removes every resource this project created, so nothing can
# ever appear on a bill.
#
# EDIT THESE THREE LINES FIRST:
BUCKET="your-bucket-name-here"
FUNCTION="qr-attendance-api"
USER_POOL_ID="ap-south-1_XXXXXXXXX"
# CloudFront must be disabled in the console first (see notes at the
# bottom), then deleted. AWS does not allow deleting a live one.
# ===================================================================

echo "This will permanently delete your QR Attendance resources."
read -p "Type DELETE to continue: " confirm
[ "$confirm" = "DELETE" ] || { echo "Cancelled."; exit 1; }

echo "--- DynamoDB tables ---"
for t in att_Users att_Classes att_Enrollments att_Sessions att_Attendance; do
  aws dynamodb delete-table --table-name $t >/dev/null 2>&1 \
    && echo "  deleted $t" || echo "  $t not found (already gone)"
done

echo "--- Lambda function ---"
aws lambda delete-function --function-name "$FUNCTION" >/dev/null 2>&1 \
  && echo "  deleted $FUNCTION" || echo "  $FUNCTION not found"

echo "--- CloudWatch log group ---"
aws logs delete-log-group --log-group-name "/aws/lambda/$FUNCTION" >/dev/null 2>&1 \
  && echo "  deleted logs" || echo "  logs not found"

echo "--- S3 bucket ---"
aws s3 rm "s3://$BUCKET" --recursive >/dev/null 2>&1
aws s3api delete-bucket --bucket "$BUCKET" >/dev/null 2>&1 \
  && echo "  deleted $BUCKET" || echo "  $BUCKET not found"

echo "--- Cognito user pool ---"
aws cognito-idp delete-user-pool --user-pool-id "$USER_POOL_ID" >/dev/null 2>&1 \
  && echo "  deleted user pool" || echo "  user pool not found"

echo ""
echo "STILL TO DO BY HAND:"
echo "  1. CloudFront console  -> select your distribution -> Disable"
echo "     Wait about 15 minutes for the status to say Disabled, then Delete."
echo "  2. IAM console -> Roles -> delete the Lambda execution role."
echo "  3. KEEP your \$1 budget alert. It costs nothing and protects you."
echo ""
echo "Then open Billing -> Bills and confirm the total is \$0.00."
echo "Made by Saurav"
