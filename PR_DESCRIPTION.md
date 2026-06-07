## Summary
Fix Docker image build failure reported in #21 by removing a pnpm/Node runtime incompatibility and correcting workspace configuration required during `pnpm build` in the container.

## Problem
Docker build failed at dependency/build stages with:
- `This version of pnpm requires at least Node.js v22.13`
- `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite`
- `pnpm build` failed with `packages field missing or empty`

The image uses `node:20-alpine`, but `corepack prepare pnpm@latest --activate` pulled pnpm v11, which requires newer Node and references `node:sqlite`.

## Root Cause
1. `Dockerfile` installed `pnpm@latest`, allowing a major upgrade incompatible with Node 20.
2. `pnpm-workspace.yaml` did not declare a `packages` field, which causes pnpm to fail when workspace config is present.

## Changes
1. Pin pnpm in Docker image setup to a Node 20 compatible version:
   - `pnpm@9.15.4` via corepack in `Dockerfile`.
2. Add required workspace package declaration for this single-package repo:
   - `packages: ['.']` in `pnpm-workspace.yaml`.

## Why this fix
- Keeps current Node 20 base image unchanged (minimal and low risk).
- Avoids accidental future breakage from `pnpm@latest` major upgrades.
- Aligns with existing lockfile major (`lockfileVersion: '9.0'`).

## Validation
Executed:
- `docker build -t aicomicbuilder:test /home/calelin/dev/AIComicBuilder`

Result:
- Build completed successfully.
- `pnpm install --frozen-lockfile` succeeded.
- `pnpm build` succeeded.
- Final image was produced: `aicomicbuilder:test`.

## Files Changed
- `Dockerfile`
- `pnpm-workspace.yaml`
