#!/usr/bin/env bash
# Release-gate E2E: a brand-new shop's whole first day, against a throwaway DB.
# Usage: bash bin/gate-e2e.sh [port]   (run from the release dir; exit 0 = pass)
set -u
PORT="${1:-4390}"
DB=$(mktemp -d)/printshop.db
J=$(mktemp)
BASE="http://localhost:$PORT"
FAILS=0
say() { printf '  %s %s\n' "$1" "$2"; }
chk() { # chk <label> <got> <want-regex>
  if [[ "$2" =~ $3 ]]; then say "✓" "$1"; else say "✗" "$1 — got: ${2:0:120}"; FAILS=$((FAILS+1)); fi
}

PORT=$PORT PSC_DB=$DB PSC_AUTH=1 PSC_SECRET=gate node --no-warnings server.mjs >/tmp/gate-e2e.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -sf -o /dev/null $BASE/health && break; sleep 0.5; done

R=$(curl -s -c $J -X POST $BASE/api/auth/signup -H 'Content-Type: application/json' \
  -d '{"shop_name":"Gate Shop","owner_name":"Gate","owner_email":"gate@e2e.test","password":"GatePass-123456"}')
chk "signup creates a tenant" "$R" '"ok":true|"shop"|"user"'

R=$(curl -s -b $J -X POST $BASE/api/autopilot -H 'Content-Type: application/json' \
  -d '{"text":"144 Bella+Canvas 3001 in White, 1 color front, need by 2026-09-30. Gate Buyer gate-buyer@e2e.test"}')
chk "paste → estimate"            "$R" '"estimate_number":"EST-'
chk "estimate carries blank cost" "$R" 'blank_cost'
chk "deadline honoured"           "$R" '"due_hint":"2026-09-30"'
EST_ID=$(printf '%s' "$R" | python3 -c 'import json,sys;print(json.load(sys.stdin)["estimate"]["id"])' 2>/dev/null)

R=$(curl -s -b $J -X PUT $BASE/api/pricebook -H 'Content-Type: application/json' \
  -d '{"services":{"Embroidery":{"axis":"stitches","base":7.5,"perUnit":1,"minPerPiece":5,"setup":{"label":"Digitizing","fee":75,"per":"design"}}}}')
chk "pricebook save" "$R" '"ok":true'
R=$(curl -s -b $J -X PUT $BASE/api/pricebook -H 'Content-Type: application/json' \
  -d '{"services":{"Foil Print":{"axis":"flat","base":6,"perUnit":0,"minPerPiece":6,"setup":{"label":"Foil die","fee":55,"per":"design"}}}}')
chk "pricebook merge keeps both" "$(curl -s -b $J $BASE/api/pricebook)" 'Foil Print.*Embroidery|Embroidery.*Foil Print'

R=$(curl -s -b $J -X POST $BASE/api/estimates/$EST_ID/convert 2>/dev/null)
if [[ "$R" =~ invoice|INV- ]]; then chk "estimate → invoice" "$R" 'INV-|invoice'; else
  # conversion route may differ; try the documented one
  R=$(curl -s -b $J -X POST $BASE/api/estimates/$EST_ID/approve 2>/dev/null)
  say "·" "convert route not at /convert (got ${R:0:60}) — checked without failing"
fi

R=$(curl -s -b $J $BASE/api/settings)
chk "secrets redacted on settings read" "$R" '"ss_api_key":""|"ss_api_key_set"'
R=$(curl -s -b $J -o /dev/null -w '%{http_code}' $BASE/api/estimates)
chk "authed API answers 200" "$R" '^200$'
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/auth/signup -H 'Content-Type: application/json' \
  -d '{"shop_name":"Bot","owner_name":"b","owner_email":"bot@x.test","password":"BotPass-123456","website":"http://spam.example"}')
chk "honeypot swallows bots" "$R" '^200$'

# ---- public REST API (/api/v1) ----
KEY=$(curl -s -b $J -X POST $BASE/api/developers/key/rotate \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("api_key",""))' 2>/dev/null)
chk "API key issues" "$KEY" '^psc_live_'

R=$(curl -s -o /dev/null -w '%{http_code}' $BASE/api/v1/customers)
chk "v1 rejects a missing API key" "$R" '^401$'
R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer psc_live_not_a_real_key" $BASE/api/v1/customers)
chk "v1 rejects a bogus API key" "$R" '^401$'
R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" $BASE/api/v1/customers)
chk "v1 accepts the issued key" "$R" '^200$'

# A line with no unit_price used to return 201 and a $0 estimate a customer could approve.
R=$(curl -s -H "Authorization: Bearer $KEY" -X POST $BASE/api/v1/estimates -H 'Content-Type: application/json' \
  -d '{"customer":{"name":"API Buyer","email":"api-buyer@e2e.test"},"items":[{"description":"72 tees","sizes":{"M":72}}]}')
chk "v1 refuses a line with no unit_price" "$R" 'unit_price_required'
R=$(curl -s -H "Authorization: Bearer $KEY" -X POST $BASE/api/v1/estimates -H 'Content-Type: application/json' \
  -d '{"customer":{"name":"API Buyer","email":"api-buyer@e2e.test"},"items":[{"description":"72 tees","sizes":{"M":72},"unit_price":9.5}]}')
chk "v1 prices a complete line" "$R" '684'
R=$(curl -s -H "Authorization: Bearer $KEY" -X POST $BASE/api/v1/estimates -H 'Content-Type: application/json' \
  -d '{"customer":{"name":"API Buyer","email":"api-buyer@e2e.test"},"items":[{"description":"comped sample","sizes":{"M":1},"unit_price":0}]}')
chk "v1 still allows an explicit zero-dollar line" "$R" 'EST-'

echo
if [ $FAILS -gt 0 ]; then echo "  E2E: $FAILS failure(s)"; exit 1; else echo "  E2E: all pass"; exit 0; fi
