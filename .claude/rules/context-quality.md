# AI Context File Quality Standards

When generating or updating AI context files, treat `AGENTS.md` as the canonical shared context and keep other files as thin bridges.

## Bridge Consistency

`AGENTS.md` owns shared commands, conventions, naming rules, and security constraints. Bridge files may subset that content when needed, but they must not contradict `AGENTS.md`. If a bridge grows because it repeats shared content, move that material back into `AGENTS.md` and leave only tool-specific instructions.

## Path and Command Verification

Every file path in a context file must exist on disk. Every command must be runnable — verify against `package.json` before writing.

## Version Accuracy

Reference correct language runtime (from `engines` in package.json), framework version (from manifests), test runner, and linter/formatter.

## Sync Points

When structure, dependencies, commands, or conventions change, update `AGENTS.md` first. Then update only the bridge files that reference that content.
