# Threat model (summary)

| Threat | Mitigation | Evidence |
|---|---|---|
| One company reads or changes another's data | Forced RLS, non-bypass role, composite FKs, tenant in every query path | `security.test.ts`, `tenancy*.test.ts` |
| Agency sees other agencies' candidates or the company database | Agency-scoped endpoints, stored submission profile only | `agency-portal.test.ts` |
| Company reassigns candidate ownership | No such permission; first-come credit; append-only ownership events | `ownership.test.ts` |
| Forgotten authentication on a new route | Route-table test: all non-public routes must return 401 | `security.test.ts` |
| Stolen or guessed one-time link | 256-bit random, hash-only storage, expiry, single use, fragment delivery, no logging | `invitations`, `feedback-links` tests |
| Brute force on login or links | Per-route rate limits | `auth.test.ts` |
| CSRF | SameSite cookie plus Origin check | `auth.test.ts` |
| SQL injection | Parameterised queries only (Kysely); metacharacter probe in tests | `security.test.ts` |
| Malicious upload or path traversal | Content sniffing, generated keys, scanner, signed links | `candidates.test.ts`, `security.test.ts` |
| Data leaves through export | Permission-resolved columns, requester-only signed link, expiry, audit | `exports.test.ts` |
| CSV formula injection | Leading apostrophe on cells starting `= + - @ tab CR` | `exports.test.ts` |
| Tampering with history | Append-only triggers and revoked grants | `permissions.test.ts`, `security.test.ts` |
| Insider misuse | Audit events for exports, ownership, approvals, feedback corrections | audit tests |
| Vulnerable dependencies | `npm audit` gate | `security.test.ts` |

Out of scope today: nation-state attackers, a compromised database owner account, a compromised host, denial of service beyond per-route rate limits, and anything involving third-party providers not yet connected.
