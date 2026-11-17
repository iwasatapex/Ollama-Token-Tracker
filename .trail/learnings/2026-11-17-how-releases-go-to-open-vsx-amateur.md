---
title: "How releases go to Open VSX: merge to master, bump by what changed, maintainer publishes with their own token"
author: Amateur
date: 2026-11-17
branch: master
cost: { minutes: 3, tokens: 18631 }
id: l-cd7cfb28
scope: repo
status: active
src: agent
touches:
  - package.json
  - readme.md
  - ".prettierrc"
  - ".vscodeignore"
  - extension.js
  - icon-build/build-font.js
---

## Decided
- Releases go to Open VSX (the registry VSCodium uses), under the 4m4teur namespace.
- Merge the release into master and push before publishing, so the published package always matches master.
- Version by what changed: a release that adds user-visible features gets a minor bump (5.1.x -> 5.2.0), not a patch, even if the patch number was never published.
- The maintainer runs the publish command themselves, with the token read from a hidden prompt into OVSX_PAT. The agent only builds and checks the .vsix and hands over the command.

## Tried and ruled out
- Publishing under the current version 5.1.2: dropped because it hides how much changed since the last published 5.1.0.
- Passing the token on the command line or pasting it into the chat: ruled out so the token never lands in shell history or a transcript.
- Publishing from the feature branch before merging: dropped so master and the published release can't drift apart.

## Watch out
- A published version can't be reused or replaced; any fix after publishing needs a new number (e.g. 5.2.1).
- Check what is already live first: curl https://open-vsx.org/api/4m4teur/ollama-token-tracker
- An agent's attempt to fetch ovsx with npx -y was blocked by Claude Code's auto-mode permission check; the maintainer's own npx works.

In the code:
- Build: vsce package --no-dependencies (the .vsix is gitignored; .vscodeignore keeps it to 12 files)
- Publish (fish): read -s -P 'Open VSX token: ' -x OVSX_PAT; npx ovsx publish ollama-token-tracker-<version>.vsix; set -e OVSX_PAT
- Version lives in package.json; the readme changelog heading is renamed to match.
