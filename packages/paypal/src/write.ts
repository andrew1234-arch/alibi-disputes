// Write surface (@alibi/paypal/write). Imported ONLY by apps/web server routes,
// after the approval gate (CLAUDE §1.1). Never by @alibi/agent.
//
// M2: provideEvidence(id, payload, files) and sendMessage(id, text).
// VERIFY before implementing (docs/OPEN_QUESTIONS.md):
//   - multipart part names: the OpenAPI spec only shows "evidence-file"; PayPal's
//     guide shows an `input` JSON part plus file parts. Confirm against sandbox.
//   - Content-Type: multipart/related vs multipart/form-data.
//   - file types / size / count limits.

export {};
