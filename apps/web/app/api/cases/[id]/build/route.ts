import { getContext } from "@/lib/server/context";
import { makeBuildRoute } from "@/lib/server/routes";

export const dynamic = "force-dynamic";
export const POST = makeBuildRoute(getContext);
