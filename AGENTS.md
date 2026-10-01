# Development Rules

## General Principle

- Keep it simple and stupid; keep answers short and concise.

## Conversational Style

- Technical prose only, be direct.
- When the users asks a question, answer it first before making edits or running implementation commands.

## Git

- Do not commit to the `main` branch.
- Stage explicit files (`git add <path1> ...`) YOU changed in THIS session; run `git status` and verify you are only staging your files before committing; never `git add -A` or `git add .`.
- Keep message informative and concise with format: `{feat,fix,docs}[(cli,core,daemon,protocol)]: <commit message> (optional multiple lines)`.
