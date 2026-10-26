# ADR: Ordered preparation and parallel read batches

- Status: Proposed
- Date: 2026-10-12

## Context

The runtime globally permits parallel execution but overrides every tool except
Task to sequential. pi consequently serializes independent Read/Glob/Grep calls.
Simply changing those flags is unsafe: file preflight currently changes the
parent prompt, including when invoked through delegated tool closures.

## Decision

Use pi-agent-core's ordered preparation / concurrent execution /
ordered result submission contract. Centralize the Read/Glob/Grep candidate
allowlist and the batch rule that keeps Task mixed with those reads sequential;
unknown tools default to sequential. Keep existing Host permission and capacity
ownership. Do not introduce another batch executor.

Move parent file preflight after mode and extension checks in beforeToolCall.
Use a weak argument-identity map to bind canonical parameters to the validated
call; unused records are collectible after cancellation or rejection. Direct
invocations still run preflight. Delegate preparation has an explicit prompt
sink, and AsyncLocalStorage preserves that sink for direct delegated executions
without sharing mutable current-agent state. Delegate prompt updates use the
same chronological system transcript sections as the parent.

## Consequences

Independent reads/searches overlap without changing writes or Bash policy.
Task-only batches retain fan-out, while a mixed Task/read batch is kept
sequential: a read ordered before `Task` finishes before the delegate starts, and
a read ordered after a writable `Task` in the same batch waits for that delegate
to settle before dispatching to Host, while `Task` itself still returns its ADR
0089 started notice immediately. Per-path shared-read / exclusive-write
locking in `PathMutex` also prevents a parent `Read` from overlapping an
in-flight shared-workspace delegate `Write` or `Edit` on the same file.
Regression tests pin both model orders (read then `Task`, and `Task` then read),
Task-only fan-out, read-only batches, same-path `Edit` vs `Read` serialization,
and a failed delegate that still lets the parent read proceed. Delegate path
rules now follow their own ordered calls instead of mutating the parent.
Instruction resolution claims remain immutable, per-prompt cached promises;
shared caching does not share the prompt mutation sink. Source-order results
still come from pi.

Existing running file RPCs drain on Stop; finer cancellation and Host-owned
file resource leases belong to separate changes.

## Alternatives

- Parallelize execute while retaining prompt updates there: completion order
  would select sibling rules and delegates would still overwrite parent state.
- Serialize all reads behind a prompt mutex: would preserve the bottleneck.
- Fork pi's batch executor: duplicates an already-supported contract.
