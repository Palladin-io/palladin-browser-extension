# Security Policy

Palladin is a zero-knowledge password manager. We take security reports
seriously and appreciate responsible disclosure.

## Reporting a vulnerability

Please report suspected vulnerabilities privately to **security@palladin.io**.

- Do **not** open a public issue, pull request, or discussion for a security
  problem.
- Include enough detail to reproduce: affected version/commit, browser and
  version, steps, and impact. Proof-of-concept code is welcome.
- Do **not** include real credentials, master passwords, recovery phrases, or
  other secrets in your report.

## Our commitment

- We will acknowledge your report within **3 business days**.
- We will keep you updated on our assessment and remediation progress.
- We will credit reporters who wish to be named once a fix has shipped.

## Scope

In scope: this browser extension (background service worker, content scripts,
popup, and the message bridge between them). Vulnerabilities that break the
zero-knowledge model - a path by which plaintext credentials, keys, or the master
password could leak to the server, to a web page, or to persistent storage - are
the highest priority.

Out of scope: threats explicitly outside our model, including malware already
running with the user's privileges on the local device. We still want to hear
about anything that surprises you.

## Safe harbor

We will not pursue legal action for good-faith security research that respects
user privacy, avoids data destruction and service disruption, and gives us a
reasonable chance to remediate before public disclosure.
