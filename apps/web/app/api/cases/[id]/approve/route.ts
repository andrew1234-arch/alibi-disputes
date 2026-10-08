import { getContext } from "@/lib/server/context";
import { makeApproveRoute } from "@/lib/server/routes";

export const dynamic = "force-dynamic";
export const POST = makeApproveRoute(getContext);
