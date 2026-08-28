# Inject provider contract fixture

`v1/secure-session.json` is vendored byte-for-byte from
`palladin-agent/runtime/contracts/inject-provider/v1/secure-session.json` at
commit `756ed3f741bf25d066ea7a6fcdb2841d0d31798a`.

The fixture contains synthetic inputs only. It freezes the Native Messaging
handshake and encrypted frame boundary shared by the CLI host and extension.
Update it only together with the producer contract and both contract suites.
