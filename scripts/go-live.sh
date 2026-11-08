#!/bin/bash
# Publish the corpus service: the public repo, the Worker, the bucket's domain and the first recordings.
#
#   scripts/go-live.sh <Cloudflare zone ID of trunkrecorder.pro>
set -euo pipefail
ZONE_ID=${1:?the zone ID, from the Overview page of trunkrecorder.pro in the Cloudflare dashboard}
TRP=${TRP:-$HOME/Projects/trunk-recorder-lite}
API=https://trunkrecorder.pro/corpus/api/v1

gh repo create TrunkRecorder/trunk-recorder-corpus --public --source . --push --description "Public IQ recordings contributed from Trunk Recorder Pro"

npm run deploy
ADMIN=$(openssl rand -hex 32)
DECODE=$(openssl rand -hex 32)
printf %s "$ADMIN" | npx wrangler secret put ADMIN_TOKEN
printf %s "$DECODE" | npx wrangler secret put DECODE_TOKEN
gh secret set DECODE_TOKEN -R TrunkRecorder/trunk-recorder-corpus --body "$DECODE"
gh secret set CORPUS_ADMIN_TOKEN -R TrunkRecorder/trunk-recorder-pro --body "$ADMIN"

npx wrangler r2 bucket domain add trp-iq --domain iq.trunkrecorder.pro --zone-id "$ZONE_ID"

DECODE_TOKEN=$DECODE python3 scripts/seed.py "$TRP/target/release/trunk-pro" "$TRP/corpus/corpus.json" "$TRP/captures/scenarios" "$API"

gh variable set CORPUS_READY --body true -R TrunkRecorder/trunk-recorder-pro
curl -s "$API/submissions" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["submissions"]), "recordings listed")'
