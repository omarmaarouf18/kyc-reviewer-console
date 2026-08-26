# Contract Sync (saas-core -> kyc-reviewer-console)

saas-core fires a `repository_dispatch` of type `reviewer-api-contract` on
pushes to `main` that touch the reviewer API contract surface. This workflow
responds by running the console's full test suite so a breaking change to the
KYB/KYE review endpoints surfaces immediately instead of at review time.

Secrets required: none for this file beyond the default `GITHUB_TOKEN`
(the dispatching side in saas-core holds the PAT).
