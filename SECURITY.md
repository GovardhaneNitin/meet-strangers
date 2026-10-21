# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through
GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" on the repository's **Security** tab), including steps to reproduce and
the impact you observed.

## Scope

In scope: the signaling server, the web client, the wire protocol, and the provided deployment
configuration (`Dockerfile`, `docker-compose.yml`, `deploy/turnserver.conf`).

## Design notes and known limitations

The threat model and mitigations are summarized in the README's
[Security & privacy model](README.md#security--privacy-model). Accepted limitations:

- **Peer IP exposure.** In the default `ICE_TRANSPORT_POLICY=all`, a peer can learn the other
  peer's IP address from ICE candidates. Operators who need to prevent this must enable TURN and set
  `ICE_TRANSPORT_POLICY=relay`.
- **Trust in the signaling server.** WebRTC media is encrypted end to end between browsers
  (DTLS-SRTP), but the key fingerprints are exchanged through the signaling server. A compromised
  server could therefore attempt a man-in-the-middle attack. This is inherent to browser WebRTC
  without out-of-band verification.
- **Moderation.** There is no automated content analysis. Abuse handling relies on reports from
  distinct users and temporary IP-based bans.
- **Age verification.** The 18+ requirement is self-declared.
