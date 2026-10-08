import { getContext } from "@/lib/server/context";
import { makeHealthRoute } from "@/lib/server/routes";

export const dynamic = "force-dynamic";
export const GET = makeHealthRoute(getContext);
