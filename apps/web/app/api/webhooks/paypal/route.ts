import { getContext } from "@/lib/server/context";
import { makeWebhookRoute } from "@/lib/server/routes";

export const dynamic = "force-dynamic";
export const POST = makeWebhookRoute(getContext);
