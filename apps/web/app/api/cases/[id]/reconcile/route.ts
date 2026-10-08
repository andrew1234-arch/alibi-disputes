import { getContext } from "@/lib/server/context";
import { makeReconcileRoute } from "@/lib/server/routes";

export const dynamic = "force-dynamic";
export const POST = makeReconcileRoute(getContext);
