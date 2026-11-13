# Project overview

## What ATLAS is

ATLAS is an **Access Control Server (ACS)** for EMV 3-D Secure (3DS). In the 3DS model, the ACS is the
issuer-side component: it receives authentication requests for an issuer's cards (via the card scheme's
Directory Server), decides whether a transaction can be authenticated frictionlessly, must be challenged,
or must be declined, runs any cardholder challenge, and returns the authentication result and
cryptographic authentication value.

ATLAS is being built as an independent, demonstrable platform — multi-issuer, scheme-independent and
backed by a working local simulation environment rather than a static demonstration.

## Objectives

1. Demonstrate a credible, well-architected ACS for **Visa Secure** and **Mastercard Identity Check**.
2. Process EMV 3DS authentication with frictionless, challenge and decline outcomes.
3. Let issuers configure their own fraud rules and authentication methods.
4. Make scheme and regulatory compliance (including PSD2 SCA where applicable) explicit and testable.
5. Support many issuers on one platform with strict, backend-enforced isolation and granular roles.
6. Provide complete reporting and a trustworthy audit trail.
7. Remain portable, so the codebase can — subject to approval — move into a company-controlled
   environment and integrate with existing infrastructure.

## Intended capabilities (target state)

| Area                   | Capability                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------- |
| Protocol               | EMV 3DS message processing (AReq/ARes, CReq/CRes, RReq/RRes, Erro), version negotiation |
| Schemes                | Separate Visa and Mastercard adapters; ACS Core remains scheme-agnostic                 |
| Decisioning            | Issuer-configurable risk rules; frictionless / challenge / decline outcomes             |
| Authentication methods | OTP, out-of-band, biometrics and others via pluggable providers                         |
| Compliance             | SCA exemption handling, scheme rule enforcement, compliance evidence                    |
| Administration         | One portal for platform administrators and issuer users; permission-driven (Stage 1A)   |
| Oversight              | Reporting projections and a tamper-evident audit trail                                  |
| Simulation             | Local 3DS Server and Directory Server simulation for end-to-end testing                 |

See [ROADMAP.md](roadmap/ROADMAP.md) for when each capability is planned.

## Development approach

- **Staged delivery.** Each stage is reviewed before the next begins. Stage 0 laid the foundation;
  Stage 1A makes the portal a working, secure, multi-tenant issuer administration platform (sign-in,
  roles and permissions, issuer registry and configuration, user management, audit trail); the ACS
  protocol engine follows in Stage 1B.
- **Microservices from the start**, each owning its own data, sharing only versioned contracts.
- **Contracts first.** Inter-service APIs and events are defined in `@atlas/contracts`, validated at
  runtime and exportable as JSON Schema.
- **Open source first**, preferring permissive licences; licences are tracked in
  [MIGRATION_STRATEGY.md](MIGRATION_STRATEGY.md#dependency-and-licence-register).
- **Automated quality gates** on every change: formatting, linting, type-checking, unit, smoke,
  integration and end-to-end tests, container builds and dependency audit.
- **Synthetic data only.** No real card, cardholder or transaction data is used at any stage of
  independent development.

## Independent project status

ATLAS is developed **outside any employer organisation**, in a personal repository and development
environment. It does not use, and must not be given access to:

- employer repositories, credentials, infrastructure or confidential documentation;
- customer, cardholder or production transaction data;
- internal or production scheme credentials or certificates;
- proprietary scheme code or unlicensed implementations.

All scheme behaviour is implemented greenfield from publicly available or appropriately licensed
material. Where requirements depend on documents that are not available to an independent project
(for example, scheme programme guides), this is recorded explicitly in the
[compliance matrix](compliance/COMPLIANCE_MATRIX.md) rather than assumed.

Any future transfer into a company-controlled environment requires the approvals described in
[MIGRATION_STRATEGY.md](MIGRATION_STRATEGY.md).

## Non-production limitations

ATLAS is **not** production software. In particular:

- It is not PCI DSS or PCI 3DS assessed, and the existence of security foundations does not imply
  compliance.
- It has no EMVCo Letter of Approval and no Visa or Mastercard certification.
- It has no HSM integration; no real cryptographic keys or certificates are used.
- Local infrastructure uses development-grade configuration (single instances, generated local
  passwords, no TLS between services).
- Identity runs on a development-mode Keycloak with synthetic demo accounts; service-to-service
  traffic is token-authenticated but not yet mutually TLS-authenticated (Stage 7).

These limitations are tracked in the [security model](security/SECURITY_MODEL.md) and the
[roadmap](roadmap/ROADMAP.md).
