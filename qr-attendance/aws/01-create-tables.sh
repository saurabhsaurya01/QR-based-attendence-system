#!/bin/bash
# ===================================================================
# QR ATTENDANCE SYSTEM - create the database tables
# Made by Saurav
#
# HOW TO USE
#   1. Sign in to the AWS Console
#   2. Make sure the region box (top right) says the region you chose
#   3. Click the terminal icon at the top to open AWS CloudShell
#   4. Paste this whole file in and press Enter
#
# COST
#   Every table below uses PROVISIONED capacity and the STANDARD
#   table class, because those are the only settings the DynamoDB
#   free allowance covers. On-demand mode is charged from the very
#   first read or write.
#
#   Capacity used by this script:
#       reads  : 2 + 2 + 2 + 3 + 2 + 3 + 3 + 3 = 20  (free allowance 25)
#       writes : 2 + 2 + 2 + 3 + 2 + 3 + 3 + 3 = 20  (free allowance 25)
#   That leaves 5 units of headroom. Do not create other DynamoDB
#   tables in this region or you will go over and start paying.
# ===================================================================

set -e
echo "Creating tables in region: $AWS_REGION"

# ---- 1. Users -----------------------------------------------------
aws dynamodb create-table \
  --table-name att_Users \
  --attribute-definitions AttributeName=userId,AttributeType=S \
                          AttributeName=email,AttributeType=S \
  --key-schema AttributeName=userId,KeyType=HASH \
  --provisioned-throughput ReadCapacityUnits=2,WriteCapacityUnits=2 \
  --table-class STANDARD \
  --global-secondary-indexes '[{
      "IndexName":"email-index",
      "KeySchema":[{"AttributeName":"email","KeyType":"HASH"}],
      "Projection":{"ProjectionType":"ALL"},
      "ProvisionedThroughput":{"ReadCapacityUnits":2,"WriteCapacityUnits":2}
  }]'

# ---- 2. Classes ---------------------------------------------------
aws dynamodb create-table \
  --table-name att_Classes \
  --attribute-definitions AttributeName=classId,AttributeType=S \
  --key-schema AttributeName=classId,KeyType=HASH \
  --provisioned-throughput ReadCapacityUnits=2,WriteCapacityUnits=2 \
  --table-class STANDARD

# ---- 3. Enrollments (which student is in which class) -------------
aws dynamodb create-table \
  --table-name att_Enrollments \
  --attribute-definitions AttributeName=classId,AttributeType=S \
                          AttributeName=studentId,AttributeType=S \
  --key-schema AttributeName=classId,KeyType=HASH \
                AttributeName=studentId,KeyType=RANGE \
  --provisioned-throughput ReadCapacityUnits=3,WriteCapacityUnits=3 \
  --table-class STANDARD \
  --global-secondary-indexes '[{
      "IndexName":"student-index",
      "KeySchema":[{"AttributeName":"studentId","KeyType":"HASH"}],
      "Projection":{"ProjectionType":"ALL"},
      "ProvisionedThroughput":{"ReadCapacityUnits":2,"WriteCapacityUnits":2}
  }]'

# ---- 4. Sessions (one lecture's attendance window) ----------------
aws dynamodb create-table \
  --table-name att_Sessions \
  --attribute-definitions AttributeName=sessionId,AttributeType=S \
  --key-schema AttributeName=sessionId,KeyType=HASH \
  --provisioned-throughput ReadCapacityUnits=3,WriteCapacityUnits=3 \
  --table-class STANDARD

# ---- 5. Attendance ------------------------------------------------
# The pair (sessionId, studentId) is the primary key. That pair can
# only exist once, and THAT is what makes duplicate attendance
# impossible - the database itself refuses the second write.
aws dynamodb create-table \
  --table-name att_Attendance \
  --attribute-definitions AttributeName=sessionId,AttributeType=S \
                          AttributeName=studentId,AttributeType=S \
                          AttributeName=markedAt,AttributeType=N \
  --key-schema AttributeName=sessionId,KeyType=HASH \
                AttributeName=studentId,KeyType=RANGE \
  --provisioned-throughput ReadCapacityUnits=3,WriteCapacityUnits=3 \
  --table-class STANDARD \
  --global-secondary-indexes '[{
      "IndexName":"student-index",
      "KeySchema":[{"AttributeName":"studentId","KeyType":"HASH"},
                   {"AttributeName":"markedAt","KeyType":"RANGE"}],
      "Projection":{"ProjectionType":"ALL"},
      "ProvisionedThroughput":{"ReadCapacityUnits":3,"WriteCapacityUnits":3}
  }]'

echo ""
echo "Waiting for the tables to become ACTIVE..."
for t in att_Users att_Classes att_Enrollments att_Sessions att_Attendance; do
  aws dynamodb wait table-exists --table-name $t
  echo "  $t is ready"
done

echo ""
echo "All five tables created. Total capacity used: 20 read / 20 write."
echo "Made by Saurav"
