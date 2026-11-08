# Simulator

**Reserved — implemented in Stage 1B** (simulated Visa and Mastercard Directory Servers and AReq/ARes). No simulator code exists yet.

The simulator will make ATLAS a working environment rather than a static demonstration by playing the
roles ATLAS cannot reach in independent development:

| Role                                             | Behaviour                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 3DS Server                                       | Generates synthetic AReqs (browser, app and 3RI channels) for synthetic cards and merchants |
| Directory Server (Visa-like and Mastercard-like) | Routes AReqs to the scheme adapters, receives ARes and RReq                                 |
| Cardholder device                                | Drives browser and app challenge flows (CReq/CRes)                                          |

Principles: synthetic data only; behaviour derived from the EMVCo specification, never from proprietary
scheme material; scenarios defined as data so tests and demos can replay them. See
[PROTOCOL_SUPPORT.md](../docs/protocol/PROTOCOL_SUPPORT.md).
