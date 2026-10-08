import { getContext } from "@/lib/server/context";
import { makeCaseRoute } from "@/lib/server/routes";

export const dynamic = "force-dynamic";
export const GET = makeCaseRoute(getContext);
