# Compliance matrix

> **Purpose:** a structured starting framework, not a compliance claim. ATLAS is not compliant with,
> assessed against, or certified under any standard or programme listed here.
>
> No scheme rules are invented. Where a requirement depends on documentation this independent project
> does not hold, it is recorded as a research item.

## Status definitions

| Status         | Meaning                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Confirmed**  | The source is public, identified, and known to apply to an ACS at the level described. Detailed clauses still require review of the current text before implementation. |
| **Research**   | The source or requirement must be obtained, read or confirmed before design or implementation.                                                                          |
| **Assumption** | Believed true, not verified. Must be confirmed or rejected; never relied on for a compliance decision.                                                                  |

Each row also records the ATLAS stage expected to address it, and current progress
(`—` none · `Design` documented · `Partial` foundation exists · `Done` implemented and tested).

## EMVCo

| ID     | Source                                            | Requirement area                                               | Status    | Stage | Progress | Notes                                                                               |
| ------ | ------------------------------------------------- | -------------------------------------------------------------- | --------- | ----- | -------- | ----------------------------------------------------------------------------------- |
| EMV-01 | EMV 3DS Protocol and Core Functions Specification | ACS message processing (AReq/ARes, CReq/CRes, RReq/RRes, Erro) | Confirmed | 1B–3  | Design   | See [PROTOCOL_SUPPORT.md](../protocol/PROTOCOL_SUPPORT.md)                          |
| EMV-02 | Same                                              | Supported protocol versions (2.2.0, 2.3.x)                     | Research  | 1B    | —        | Confirm latest published version and scheme acceptance                              |
| EMV-03 | Same                                              | Message field validation and conditional presence              | Confirmed | 1B    | —        | Implemented as versioned schemas                                                    |
| EMV-04 | Same                                              | Error message generation                                       | Confirmed | 1B    | —        | Protocol endpoints must not use the ATLAS problem envelope (enforced by convention) |
| EMV-05 | Same                                              | Browser and app challenge flows, UI types                      | Confirmed | 3     | —        |                                                                                     |
| EMV-06 | Same                                              | ACS signed content and app-channel encryption                  | Confirmed | 3, 7  | —        | Algorithms to be confirmed from the specification [research]                        |
| EMV-07 | EMV 3DS SDK / Split-SDK specifications            | Interaction with app-based and split-SDK flows                 | Research  | 3     | —        |                                                                                     |
| EMV-08 | EMVCo 3DS compliance testing / Letter of Approval | Formal product approval for an ACS                             | Research  | 7     | —        | Programme terms, test plans and costs to be established                             |

## Visa

| ID     | Source                              | Requirement area                                          | Status     | Stage | Progress | Notes                                                                     |
| ------ | ----------------------------------- | --------------------------------------------------------- | ---------- | ----- | -------- | ------------------------------------------------------------------------- |
| VIS-01 | Visa Secure programme documentation | Programme rules, ACS requirements                         | Research   | 1B    | —        | Documentation not available to the independent project                    |
| VIS-02 | Same                                | Authentication value (CAVV) generation and key management | Research   | 1B, 7 | —        | Simulated only until documentation and keys are obtained legitimately     |
| VIS-03 | Same                                | ECI values per outcome                                    | Assumption | 1B    | —        | Commonly published values must not be relied on without the scheme source |
| VIS-04 | Same                                | Directory server connectivity, certificates, mTLS         | Research   | 7     | —        | No live connectivity in independent development                           |
| VIS-05 | Same                                | Performance / availability obligations                    | Research   | 1B, 6 | —        |                                                                           |
| VIS-06 | Visa testing / certification        | ACS compliance testing                                    | Research   | 7     | —        |                                                                           |

## Mastercard

| ID    | Source                                            | Requirement area                                               | Status     | Stage | Progress | Notes                                                  |
| ----- | ------------------------------------------------- | -------------------------------------------------------------- | ---------- | ----- | -------- | ------------------------------------------------------ |
| MC-01 | Mastercard Identity Check programme documentation | Programme rules, ACS requirements                              | Research   | 1B    | —        | Documentation not available to the independent project |
| MC-02 | Same                                              | Authentication value (AAV / SPA) generation and key management | Research   | 1B, 7 | —        | Simulated only                                         |
| MC-03 | Same                                              | ECI values per outcome                                         | Assumption | 1B    | —        | As VIS-03                                              |
| MC-04 | Same                                              | Directory server connectivity, certificates, mTLS              | Research   | 7     | —        |                                                        |
| MC-05 | Same                                              | Data-sharing / risk-data fields and extensions                 | Research   | 2     | —        |                                                        |
| MC-06 | Mastercard testing / certification                | ACS compliance testing                                         | Research   | 7     | —        |                                                        |

## PSD2 / SCA (EEA)

| ID     | Source                                                           | Requirement area                                                                                           | Status    | Stage | Progress | Notes                                                                                    |
| ------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------- | ----- | -------- | ---------------------------------------------------------------------------------------- |
| PSD-01 | Directive (EU) 2015/2366 (PSD2)                                  | Requirement for strong customer authentication for in-scope electronic payments                            | Confirmed | 4     | —        | Applies to issuers in scope; ATLAS supports issuers' obligations, it is not itself a PSP |
| PSD-02 | Commission Delegated Regulation (EU) 2018/389 (RTS on SCA & CSC) | SCA elements (knowledge, possession, inherence), independence, dynamic linking                             | Confirmed | 3–4   | —        | Clause-level mapping to be produced from the published text                              |
| PSD-03 | Same                                                             | Exemptions (e.g. low value, transaction risk analysis, trusted beneficiaries, recurring, secure corporate) | Confirmed | 4     | —        | Thresholds and conditions to be taken from the current text, not from memory             |
| PSD-04 | Same                                                             | Fraud-rate monitoring and reporting supporting TRA                                                         | Research  | 4–5   | —        | Determine which obligations fall on the issuer vs. the ACS provider                      |
| PSD-05 | EBA Guidelines, Opinions and Q&A on SCA                          | Interpretation of SCA requirements                                                                         | Research  | 4     | —        |                                                                                          |
| PSD-06 | Payment Services Regulation / PSD3 proposals                     | Future changes to SCA                                                                                      | Research  | 4+    | —        | Track legislative status                                                                 |

## UK

| ID    | Source                                                       | Requirement area                                                      | Status    | Stage | Progress | Notes                                                                                       |
| ----- | ------------------------------------------------------------ | --------------------------------------------------------------------- | --------- | ----- | -------- | ------------------------------------------------------------------------------------------- |
| UK-01 | Payment Services Regulations 2017                            | UK implementation of SCA obligations                                  | Confirmed | 4     | —        |                                                                                             |
| UK-02 | FCA technical standards on SCA (UK SCA-RTS) and FCA guidance | UK SCA rules and exemptions, which may differ from the EU RTS         | Research  | 4     | —        | Confirm current UK divergence from EU rules                                                 |
| UK-03 | UK GDPR and Data Protection Act 2018                         | Personal data processing                                              | Confirmed | 1A+   | Partial  | Data classification and logging rules in [SECURITY_MODEL.md](../security/SECURITY_MODEL.md) |
| UK-04 | FCA operational resilience and outsourcing expectations      | Obligations on regulated issuers using ATLAS as a third-party service | Research  | 7     | —        | Relevant only if ATLAS is offered as a service to regulated firms                           |

## PCI SSC

| ID     | Source                                | Requirement area                                                  | Status    | Stage | Progress | Notes                                                                       |
| ------ | ------------------------------------- | ----------------------------------------------------------------- | --------- | ----- | -------- | --------------------------------------------------------------------------- |
| PCI-01 | PCI 3DS Core Security Standard        | Security of 3DS environments (ACS, DS, 3DS Server)                | Confirmed | 7     | —        | Applicability to the eventual deployment to be confirmed with a QSA         |
| PCI-02 | PCI DSS v4.0.1                        | Protection of account data where stored, processed or transmitted | Confirmed | 7     | Partial  | Foundations: no PAN storage, log redaction, PAN masking to first 6 / last 4 |
| PCI-03 | PCI DSS — scoping and segmentation    | Minimising cardholder-data environment scope                      | Research  | 7     | Design   | Service boundaries chosen to keep account data in few services              |
| PCI-04 | PCI DSS — secure software development | Secure SDLC, code review, dependency management                   | Confirmed | 0+    | Partial  | CI gates, dependency audit, Dependabot, pinned actions                      |
| PCI-05 | PCI DSS — key management              | Cryptographic key lifecycle, HSM usage                            | Confirmed | 7     | —        |                                                                             |
| PCI-06 | PCI DSS — logging and monitoring      | Audit trails, log review, time sync                               | Confirmed | 5, 7  | Partial  | Structured logs, audit-service design                                       |

## Unverified assumptions register

| ID   | Assumption                                                                                                           | Risk if wrong                       | How to resolve                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| A-01 | Both schemes accept EMV 3DS 2.2.0 and 2.3.x and no longer accept 2.1.0                                               | Wrong version support               | Check EMVCo publications and scheme bulletins                  |
| A-02 | Scheme adapters can be built greenfield from the EMVCo specification plus scheme documentation obtained later        | Rework of adapters                  | Obtain scheme documentation via an appropriate partner channel |
| A-03 | An ACS provider's PCI obligations are governed primarily by the PCI 3DS Core Security Standard together with PCI DSS | Incorrect security scope            | Confirm with a QSA                                             |
| A-04 | ATLAS itself is not a PSP; SCA obligations sit with the issuer, and ATLAS provides the means to meet them            | Misallocated regulatory obligations | Legal / compliance review before any commercial use            |

## Maintaining this matrix

- Every row must cite a source. New rows start as Research or Assumption.
- A row moves to Confirmed only when the source has been read and its applicability understood.
- Implementation stories reference matrix IDs; tests in `tests/compliance` reference them too (from
  Stage 4).
