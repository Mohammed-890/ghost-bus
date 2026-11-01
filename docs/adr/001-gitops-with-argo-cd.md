# 1. Deploy with GitOps (Argo CD), not a push from CI

**Decision.** CI never touches the cluster. After the end-to-end test passes on main, CI publishes the images and commits the new tag to `deploy/values-prod.yaml`. Argo CD watches that file and syncs the cluster to it.

**Why.**
- Git holds the whole deployed state: what is running is whatever the last commit says.
- Rolling back is a `git revert`.
- The cluster needs no credentials stored in CI, and Argo CD's self-heal undoes manual changes.

**Trade-off.** Every deploy adds a bot commit to main (marked `[skip ci]`), and a deploy takes as long as Argo CD's sync interval. A plain `helm upgrade` from CI would be faster for a one-person project, so Terraform keeps that path too (`install_argocd = false`).
