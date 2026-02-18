# AI Docs Folder

This folder contains the canonical context and working rules for coding agents in this repository.

## Why this layout

Based on vendor docs and conventions:

- **Codex** supports `AGENTS.md` discovery and layered overrides.
- **Claude Code** supports `CLAUDE.md` and `.claude/rules/*.md` guidance.
- **Gemini CLI** supports `GEMINI.md` context files.
- **GitHub Copilot** supports `.github/copilot-instructions.md`, plus agent instruction files such as `AGENTS.md`.

To avoid duplicating long instructions, the root-level agent files import and reference the documents in this folder.

## Files

- `PROJECT_STRUCTURE.md` - current package layout and key ownership boundaries
- `ENGINEERING_GUIDELINES.md` - coding standards, safety rules, and review expectations
- `RUNBOOK.md` - commands, setup flow, and validation checklist
