# Trunk Recorder Corpus

`trunkrecorder.pro/corpus`: public IQ recordings contributed from
[Trunk Recorder Pro](https://github.com/TrunkRecorder/trunk-recorder-pro), for anyone to test
their own build or help debug a report. One Cloudflare Worker, a D1 database and a public R2 bucket.
The design is in `research/iq-corpus.md` in that repo.

- **Upload:** an install token, then the files in 32 MiB parts through the Worker.
- **Check:** `.github/workflows/decode.yml` runs the latest released `trunk-pro` on what's been uploaded, every 15 minutes. What
  doesn't check out is deleted. Only what does is listed.
- **Public:** recordings are plain URLs at `iq.trunkrecorder.pro/blobs/<sha256>`, listed at
  `/corpus`. Decoded audio and messages are never published.
- **Regression tests:** the list lives here, and `trunk-pro tool corpus` reads it. Anyone with write access to the Trunk
  Recorder Pro repo can sign in with GitHub on the page to add or remove recordings. Signing in is optional: everything
  else is public.

```bash
npm ci
npm run check     # types, unit tests, and the whole flow against a local Worker
npm run dev
```

## Signing in

Create a GitHub OAuth app owned by the TrunkRecorder organization, with the callback URL
`https://trunkrecorder.pro/corpus/auth/callback`. Put its client ID in `GITHUB_CLIENT_ID` in `wrangler.toml`, and
its secret in the Worker with `wrangler secret put GITHUB_CLIENT_SECRET`. It asks for no scopes.

## Deploying

`wrangler d1 create corpus` and `wrangler r2 bucket create trp-iq`, then set the database id in
`wrangler.toml`. Give the bucket the custom domain `iq.trunkrecorder.pro`. Set the secrets
`GITHUB_CLIENT_SECRET` and `DECODE_TOKEN`, give this repo the secret `DECODE_TOKEN`, then `npm run deploy`.
