# Decisions - opencode-repos

## Task 0: Project Setup

### Placeholder Test File
**Decision**: Created `src/__tests__/setup.test.ts` with a trivial passing test.
**Rationale**: `bun test` exits with code 1 when no tests found, which would fail verification. A placeholder ensures clean test runs during development.

### tsconfig.json Pattern
**Decision**: Followed opencode-tmux tsconfig exactly rather than bun init default.
**Rationale**: Consistency with existing plugin ecosystem. The tmux pattern is proven to work with OpenCode plugin system.

### Directory Structure
**Decision**: Using `src/` directory for modules rather than flat structure.
**Rationale**: Plan specifies src/ directory. Allows separation of implementation from root-level plugin entry point.
