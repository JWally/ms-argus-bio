# Admin API — authentication

The bio API exposes four operator-only routes for inspecting and
mutating the Qdrant training collection:

- `GET  /admin/stats` — collection size and training status
- `GET  /admin/scroll` — dump all stored points (optionally raw embeddings)
- `POST /admin/flush` — delete + recreate the collection
- `POST /admin/relabel` — bulk update point payloads

All four are gated with **IAM authorization** (`HttpIamAuthorizer`).
Callers must sign requests with SigV4 using credentials that have
`execute-api:Invoke` on the API.

Client-facing routes (`/v1/challenge`, `/v1/classify`, `/v1/session`,
`/v1/verify`, `/health`) are **not** gated — they're the CAPTCHA flow
and need to be reachable from browsers.

## Endpoint discovery

```bash
aws apigatewayv2 get-apis \
  --query "Items[?contains(Name, 'ms-argus-bio')].ApiEndpoint" --output text
```

The friendly hostname (`https://api-bio-dev-jw.argus.pw`) fronts the
same API Gateway via CloudFront, so either URL works.

## Invoking from the CLI

### Option A — `awscurl` (recommended)

```bash
pip install awscurl   # one-time

awscurl --service execute-api \
  "https://api-bio-dev-jw.argus.pw/admin/stats"
```

### Option B — plain `curl` with SigV4

Requires `curl` 7.75+ built with `--aws-sigv4` support.

```bash
eval $(aws configure export-credentials --format env-no-export)

curl --aws-sigv4 "aws:amz:us-east-1:execute-api" \
     --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}" \
     ${AWS_SESSION_TOKEN:+-H "x-amz-security-token: ${AWS_SESSION_TOKEN}"} \
     "https://api-bio-dev-jw.argus.pw/admin/stats"
```

### Option C — Node SDK / Python boto3

Sign the request with `@aws-sdk/signature-v4` (Node) or
`botocore.auth.SigV4Auth` (Python).

## Expected responses

| Request                                    | Status | Meaning                     |
| ------------------------------------------ | ------ | --------------------------- |
| Unsigned                                   | `403`  | `Forbidden` — missing SigV4 |
| Signed by principal without IAM permission | `403`  | IAM policy denies invoke    |
| Signed by principal with invoke permission | `2xx`  | Handler executes            |

## Granting access

Attach this policy to the IAM user / role that should reach the admin API:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "execute-api:Invoke",
      "Resource": "arn:aws:execute-api:us-east-1:*:<api-id>/*/*/admin/*"
    }
  ]
}
```

Replace `<api-id>` with the ID from `aws apigatewayv2 get-apis` above.

## Rationale

Two of these endpoints are destructive (`flush` wipes the classifier,
`relabel` corrupts training signal) and one is a bulk data export
(`scroll` dumps biometric embeddings + JA4 fingerprints + UAs). They
must never be world-reachable. IAM auth gives:

- No static secret to rotate or leak.
- Existing AWS credentials used for `cdk deploy` also invoke these routes.
- Access revocation is immediate via IAM policy change — no restart needed.
- Audit trail in CloudTrail keyed to the caller's IAM principal.
