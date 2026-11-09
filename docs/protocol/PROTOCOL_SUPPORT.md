# EMV 3DS protocol support

> **No protocol logic is implemented in Stage 0.** This document sets the intended baseline and records
> what must be verified before implementation begins in Stage 1B.
>
> Statements marked **[verify]** reflect commonly published understanding of the EMV 3DS specification
> and scheme programmes. They must be checked against the current, properly obtained EMVCo
> specification and scheme documentation before being implemented. ATLAS does not reproduce
> specification text.

## Sources

| Source                                                           | Availability to this project                                      | Notes                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| EMVCo _EMV 3-D Secure Protocol and Core Functions Specification_ | Publicly downloadable from EMVCo, subject to EMVCo's terms of use | Primary source for message formats and flows          |
| EMVCo 3DS _SDK_, _Split-SDK_ and _Bridging_ specifications       | Public (EMVCo terms)                                              | Relevant to app-channel and scheme bridging behaviour |
| EMVCo 3DS test plans / compliance programme                      | Generally available to programme participants                     | Needed for formal ACS approval; not assumed available |
| Visa Secure programme documentation                              | Typically restricted to Visa clients/partners                     | **Not available** to the independent project          |
| Mastercard Identity Check programme documentation                | Typically restricted to Mastercard customers/partners             | **Not available** to the independent project          |

## Version baseline

| Protocol version        | Intended support            | Status                                                      |
| ----------------------- | --------------------------- | ----------------------------------------------------------- |
| 2.1.0                   | Not planned                 | [verify] widely reported as retired by the major schemes    |
| 2.2.0                   | **Baseline**                | [verify] current scheme acceptance                          |
| 2.3.x (2.3.1 and later) | **Planned** alongside 2.2.0 | [verify] exact latest version and scheme adoption timelines |

Version negotiation (`messageVersion`, and the version ranges advertised for card ranges) is owned by the
`protocol` service. Support is modelled as data — a version → feature/field matrix — so adding a version
is configuration and schema work, not a redesign.

## Messages and the ACS's role

| Message     | Direction (ACS perspective) | Purpose                                                                                                                                  | Planned stage |
| ----------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| AReq / ARes | DS → ACS / ACS → DS         | Authentication request and decision                                                                                                      | 1B            |
| CReq / CRes | Cardholder device ↔ ACS     | Challenge exchange (browser or app)                                                                                                      | 3             |
| RReq / RRes | ACS → DS / DS → ACS         | Result of a challenge                                                                                                                    | 3             |
| Erro        | Both                        | Protocol error reporting                                                                                                                 | 1B            |
| PReq / PRes | 3DS Server ↔ DS             | Card range / preparation data — **not** an ACS message; ACS card-range data reaches the DS through scheme-specific provisioning [verify] | —             |

## Planned functional coverage

| Area                     | Scope                                                                                                   | Stage                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Message schemas          | Versioned Zod/JSON schemas per message and version; strict field validation, conditional-presence rules | 1B                                          |
| Error handling           | Spec-conformant Erro generation; never the ATLAS problem envelope on protocol endpoints                 | 1B                                          |
| Device channels          | Browser (02), App (01), 3RI (03) [verify codes]                                                         | 1B                                          |
| Message categories       | Payment (01) and Non-payment (02) [verify codes]                                                        | 1B                                          |
| Transaction status       | Y, N, U, A, C, R; D (decoupled) and I (informational) for versions that define them [verify]            | 1B                                          |
| Frictionless flow        | AReq → risk + compliance → ARes (Y/N/A/U/R/I)                                                           | 1B                                          |
| Challenge flow — browser | HTML challenge via CReq/CRes                                                                            | 3                                           |
| Challenge flow — app     | Native UI types (text, single/multi-select, OOB, HTML other) [verify] with encrypted CReq/CRes          | 3                                           |
| Decoupled authentication | Out-of-band, asynchronous result via RReq                                                               | 3                                           |
| 3RI                      | Requestor-initiated, non-cardholder-present                                                             | 4                                           |
| Authentication value     | CAVV (Visa) / AAV-SPA (Mastercard) generation in scheme adapters; ECI mapping [verify values]           | 1B (simulated keys), 7 (HSM)                |
| Cryptography             | ACS signed content (JWS) and app-channel key agreement / encryption (JWE) [verify algorithms]           | 3 (software keys, simulation only), 7 (HSM) |
| Message extensions       | Scheme- and region-specific extensions handled by adapters                                              | 1B+                                         |

## Scheme-specific behaviour

Scheme behaviour belongs exclusively in `visa-adapter` and `mastercard-adapter`. Examples of what each
adapter will own, all **[verify]** against scheme documentation that is not currently available:

- directory server endpoints, certificates and mutual TLS requirements;
- authentication value format and generation;
- ECI values for each outcome;
- scheme-specific message extensions and field rules;
- scheme performance and availability requirements.

Until the documentation is obtained through an appropriate channel, adapters will implement only what
the EMVCo specification defines and what the simulator exercises, with all assumptions recorded in the
[compliance matrix](../compliance/COMPLIANCE_MATRIX.md).

## Simulation

Stage 1B adds a simulator ([`simulator/`](../../simulator/README.md)) acting as 3DS Server and Directory
Server, generating synthetic AReqs and driving challenge and RReq flows end to end. Protocol conformance
suites live in [`tests/protocol`](../../tests/protocol/README.md).

**Test data.** Stage 1B uses **synthetic/test BIN ranges only**, together with synthetic issuers,
cardholders and transactions. No real employer BIN ranges, customer information or other confidential
data may be introduced into the independent project.

## Performance

Directory servers expect ACS responses within strict time limits [verify per scheme]. This is why the
authentication path uses synchronous, timeout-bounded HTTP with no queue in the request/response path,
and why per-service latency is a first-class metric (`atlas_http_request_duration_seconds`).
