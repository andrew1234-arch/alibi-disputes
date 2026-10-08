import { getContext } from "@/lib/server/context";
import { makeSubmitRoute } from "@/lib/server/routes";

export const dynamic = "force-dynamic";
export const POST = makeSubmitRoute(getContext);
