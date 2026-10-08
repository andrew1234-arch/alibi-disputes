// Runs the stub standalone with two demo disputes, for poking at it by hand:
//   STUB_PORT=4010 pnpm --filter @alibi/test-stub start
import { makeDispute, startStub } from "./index";

const stub = await startStub({ webhookId: "STUBWEBHOOK", ...(process.env.STUB_PORT ? { port: Number(process.env.STUB_PORT) } : {}) });
stub.setDispute(makeDispute({ dispute_id: "PP-D-STUB-1" }));
stub.setDispute(makeDispute({ dispute_id: "PP-D-STUB-2", status: "UNDER_REVIEW" }));
console.log(`PayPal stub on ${stub.url}  (PAYPAL_TEST_MODE=true PAYPAL_API_BASE=${stub.url})`);
