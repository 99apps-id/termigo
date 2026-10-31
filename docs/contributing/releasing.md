# Releasing Termigo

This is the maintainer checklist for a tagged desktop and Go companion release.
`TERMIGO.md` remains the architecture source of truth. The workflow implemented
by `.github/workflows/release.yml` is authoritative when this guide and CI ever
diverge.

## Preconditions

- Start from a clean `main` synchronized with `origin/main`.
- Authenticate `gh` for `99apps-id/termigo`.
- Confirm these GitHub Actions secrets exist by name without printing values:

  ```bash
  gh secret list --app actions
  ```

  The release can build unsigned artifacts without signing credentials, but a
  production release expects the updater signing key and platform signing
  credentials. Antigravity sign-in without a prompt requires both
  `TERMIGO_ANTIGRAVITY_CLIENT_ID` and
  `TERMIGO_ANTIGRAVITY_CLIENT_SECRET`.

- Never print, commit, upload, or paste `.env.local`. `.env.local` is only a
  local build input and must remain ignored by Git.

## Version and release notes

Use the next semantic version in every version source:

- `package.json`
- `npm/termigo/package.json`
- `src-tauri/Cargo.toml`, both package and workspace versions
- the three Termigo package entries in `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`
- `CHANGELOG.md`

Keep `## [Unreleased]` at the top of the changelog and add a dated section for
the new version beneath it. Release notes should describe user-visible behavior
and important security or compatibility changes, not repeat a file inventory.

## Verification before push

Run the same required checks as CI:

```bash
pnpm lint
pnpm format:check
pnpm check-types
pnpm check:commands
pnpm check:doc-commands
pnpm check:cli-version
pnpm test
pnpm test:scripts
pnpm build
pnpm size

cd cli
test -z "$(gofmt -l .)"
go vet ./...
go test ./...
cd ../src-tauri
cargo check --all-targets --locked
cargo clippy --all-targets --locked -- -D warnings
cargo nextest run --locked
```

Build the host artifacts too. On Windows:

```powershell
pnpm build:win
```

The NSIS and MSI installers are copied to `dist-win/`. Both must remain under
the installer size budget in `TERMIGO.md`.

## Antigravity stamp contract

The release workflow maps the two repository secrets into every build matrix
job. The stamp has two independent consumers:

1. `src-tauri/build.rs` exports both values to Rust compilation, and
   `src-tauri/src/modules/oauth.rs` reads them with `option_env!` for the
   desktop app.
2. `scripts/build-cli.mjs` passes both values to the Go linker for
   `cli/internal/oauth.AntigravityClientID` and
   `cli/internal/oauth.AntigravityClientSecret`.

An unstamped development build may fall back to process environment variables,
the git-ignored `.env.local`, or a one-time prompt. A release build is expected
to contain both values. The installed-app pair is not a user token and cannot
be kept confidential after distribution; OAuth access and refresh tokens are
never stamped.

Verify local artifacts without echoing either value. A verifier may read the
expected strings into memory and report only two booleans per artifact. Check
the desktop executable and the `termigo-go-*` companion separately. The bundled
`termigo-cli` control sidecar is not an OAuth client and is not expected to
contain the pair.

## Push, CI, tag, and draft release

1. Commit the release metadata and documentation. Do not amend or force-push a
   commit that has already been shared.
2. Push `main` and wait for the `CI` workflow for that commit to pass.
3. Create an annotated `vX.Y.Z` tag at the verified commit and push the tag.
4. The tag starts `.github/workflows/release.yml`. Its platform matrix creates
   a draft GitHub Release, builds desktop bundles and Go companions, signs when
   credentials are configured, and uploads the assets.
5. Windows SignPath production signing may wait for manual approval. Do not
   publish while the workflow is pending.
6. The final manifest job patches `latest.json` after every platform build has
   finished, preventing a parallel upload from restoring stale signatures or
   asset URLs.

## Publish verification

Before changing the draft to published:

- Every required `CI` and `Release` job is green.
- The release tag resolves to the intended commit.
- NSIS, MSI, AppImage, macOS bundles, updater signatures, `latest.json`, and all
  four `termigo-go-*` assets are present.
- Signed Windows artifacts report a valid Authenticode signature when SignPath
  is configured.
- `latest.json` contains Linux and Windows updater entries with non-empty
  signatures and stable tag download URLs.
- Downloaded Go companions report the tagged version.
- SHA-256 checksums are recorded for operator verification.

Publish the existing draft only after those checks. Do not create a second
release for the same tag.

## Failure handling

- A failed `main` CI run blocks tagging. Fix forward, rerun, and tag only the
  green commit.
- A failed release workflow leaves the draft unpublished. Rerun the failed job
  after fixing credentials or infrastructure; do not move an existing public
  tag.
- If a tag was pushed to the wrong commit and no release was published, delete
  the remote and local tag, correct the commit, and recreate the annotated tag.
  Never rewrite a published release tag.
