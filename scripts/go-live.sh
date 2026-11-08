#!/bin/bash
# Publish the corpus service: the public repo, the Worker, the bucket's domain and the first recordings.
#
#   scripts/go-live.sh <Cloudflare zone ID of trunkrecorder.pro>
set -euo pipefail
ZONE_ID=${1:?the zone ID, from the Overview page of trunkrecorder.pro in the Cloudflare dashboard}
TRP=${TRP:-$HOME/Projects/trunk-recorder-lite}
API=https://trunkrecorder.pro/corpus/api/v1

# (Wrangler's login expires and this renews it; a deploy that starts with an expired one fails with code 7403.)
npx wrangler whoami > /dev/null

# (It can be run again after stopping partway.)
gh repo view TrunkRecorder/trunk-recorder-corpus > /dev/null 2>&1 || gh repo create TrunkRecorder/trunk-recorder-corpus --public --source . --description "Public IQ recordings contributed from Trunk Recorder Pro"
git push -u origin main

npm run deploy
ADMIN=$(openssl rand -hex 32)
DECODE=$(openssl rand -hex 32)
printf %s "$ADMIN" | npx wrangler secret put ADMIN_TOKEN
printf %s "$DECODE" | npx wrangler secret put DECODE_TOKEN
gh secret set DECODE_TOKEN -R TrunkRecorder/trunk-recorder-corpus --body "$DECODE"
gh secret set CORPUS_ADMIN_TOKEN -R TrunkRecorder/trunk-recorder-pro --body "$ADMIN"

npx wrangler r2 bucket domain list trp-iq | grep -q iq.trunkrecorder.pro || npx wrangler r2 bucket domain add trp-iq --domain iq.trunkrecorder.pro --zone-id "$ZONE_ID"

DECODE_TOKEN=$DECODE python3 scripts/seed.py "$TRP/target/release/trunk-pro" "$TRP/corpus/corpus.json" "$TRP/captures/scenarios" "$API"

gh variable set CORPUS_READY --body true -R TrunkRecorder/trunk-recorder-pro
curl -s "$API/submissions" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["submissions"]), "recordings listed")'
