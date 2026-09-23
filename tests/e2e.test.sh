#!/usr/bin/env bash
set -euo pipefail

API_URL="http://localhost:4000"
FIXTURE="tests/fixtures/brd_sample.pdf"

echo "Uploading BRD..."
RESPONSE=$(curl -sf -X POST "$API_URL/api/campaigns" \
  -F "file=@${FIXTURE};type=application/pdf" \
  -F "title=E2E Test Campaign" \
  -F "content_format=15s vertical video" \
  -F "target_language=id" \
  -F "deadline=2026-10-01" \
  -F "reward=Rp 500.000" \
  -F "constraints=No profanity")

CAMPAIGN_ID=$(echo "$RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")
STATUS=$(echo "$RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin)['status'])")

echo "Campaign $CAMPAIGN_ID status: $STATUS"
if [[ "$STATUS" != "planned" && "$STATUS" != "needs_review" ]]; then
  echo "FAIL: unexpected status $STATUS"
  exit 1
fi

echo "Fetching detail..."
DETAIL=$(curl -sf "$API_URL/api/campaigns/$CAMPAIGN_ID")
echo "$DETAIL" | python3 -c "import sys, json; json.load(sys.stdin)"

if [[ "$STATUS" == "planned" ]]; then
  echo "Downloading PDF..."
  curl -sf "$API_URL/api/campaigns/$CAMPAIGN_ID/pdf" -o /tmp/e2e-plan.pdf
  HEADER=$(head -c 5 /tmp/e2e-plan.pdf)
  if [[ "$HEADER" != "%PDF-" ]]; then
    echo "FAIL: downloaded file is not a PDF"
    exit 1
  fi
fi

echo "PASS"
