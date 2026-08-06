# Phase contracts

## Grilling

- Read the frozen Story or technical design, relevant team knowledge, and affected code first.
- Ask only unresolved questions, with one recommended answer at a time.
- Record each accepted decision in `DECISIONS.md` with its evidence or rationale.
- Do not edit business code.

## Specification

- Use `to-spec` for synthesis and test-seam selection.
- Keep the upstream method, but replace tracker publication with the member `SPEC.md`.
- Include outcome, constraints, acceptance criteria, verification commands, out-of-scope items, source commit, and decisions.
- Do not edit business code.

## Tickets

- Use tracer-bullet vertical slices with explicit blocking edges.
- Keep each ticket independently demonstrable or verifiable and small enough for a fresh context.
- Store the approved breakdown in `TICKETS.md`; never write `.scratch` or a remote tracker.

## Implementation

- Work only tickets whose blockers are complete.
- Prefer existing seams and repository conventions; use TDD at agreed seams.
- Run focused checks during the ticket and the full configured verification at the end.
- Do not inherit `implement`'s automatic commit behavior.

## Simplification and review

- Use `ponytail-review`, not persistent Ponytail mode, to find removable complexity.
- Resolve or explicitly waive each relevant finding before passing the Ponytail review gate.
- Run normal `code-review` after the full change; it owns correctness and spec conformance.
