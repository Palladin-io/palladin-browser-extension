# Native Agent browser capture

Capture reuses the authenticated encrypted Native Messaging connection and operation router. It is not exposed in the page/main-world bridge, popup, logs, telemetry, or storage. The native Rust runtime owns Entry typing, validation, encryption, and persistence.

Prepare the exact top-frame tab/document with `liveDetection: false`, `targetTabId`, and the exact HTTPS `targetUrl`. Then send one request using protocol `palladin.inject-provider.v1`:

```json
{
  "protocol": "palladin.inject-provider.v1",
  "type": "capture",
  "transactionId": "unique-transaction-id",
  "targetUrl": "https://example.test/account",
  "fields": [
    { "entryFieldId": "username", "selector": "#username", "read": "value" },
    { "entryFieldId": "password", "selector": "#password", "read": "value" },
    { "entryFieldId": "custom:11111111-1111-4111-8111-111111111111:concealed:value", "selector": "#token", "read": "textContent" }
  ]
}
```

Success is `capture.result`, the same transactionId, `outcome: "captured"`, and `values: [{entryFieldId, value}]` in declaration order. Failure is `capture.result` with `outcome: "rejected"` or `"provider-unavailable"` and no values. Capture never returns values in `inject.result`.

There must be 1–32 fields, unique IDs and selectors, with IDs matching `[A-Za-z0-9._:-]{1,128}`. Selectors are trimmed, nonempty, at most 1024 characters, and contain no NUL. Transactions use the existing 1–256 character identifier grammar. URLs are at most 4096 characters and cannot contain credentials. Values allow empty strings, at most 65536 UTF-8 bytes each and 262144 bytes collectively.

Each selector must match exactly one connected visible element in the top document; aliases selecting the same element also fail. `value` supports text/password/email/tel/url/search/number inputs and textareas. `textContent` supports div, span, p, pre, code, output, td, th, dd, dt, and li elements. Reads do not run arbitrary code, traverse frames, submit forms, or alter field contents. URL and document bindings are checked before and after capture. Errors are atomic and value-free.

Prepared state is consumed once. The connection replay guard rejects reused transaction IDs. Closing the operation or disconnecting drops delayed captures, including responses awaiting encryption. Mutable plaintext holders and serialized byte buffers are wiped after encrypted delivery or rejection. JavaScript strings themselves cannot be securely zeroized; there is no plaintext persistence.

Automated coverage uses synthetic values and DOM fixtures. Unit tests exercise declaration guards, multiple fields, explicit text reads, changed URL/document, missing/ambiguous/hidden elements, replay, cancellation, authenticated response routing, and buffer/holder cleanup. This does not claim real-site acceptance.
