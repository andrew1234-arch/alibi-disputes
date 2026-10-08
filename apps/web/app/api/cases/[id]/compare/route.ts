import { getContext } from "@/lib/server/context";
import { makeCompareRoute } from "@/lib/server/routes";

export const dynamic = "force-dynamic";
export const GET = makeCompareRoute(getContext);
