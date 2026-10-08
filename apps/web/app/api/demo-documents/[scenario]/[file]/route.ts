import { getContext } from "@/lib/server/context";
import { makeDemoDocumentRoute } from "@/lib/server/routes";

export const dynamic = "force-dynamic";
export const GET = makeDemoDocumentRoute(getContext);
