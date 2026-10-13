import { handleJornadas } from "@/lib/c01/jornadas/api";
import { requireSupportWrite } from "@/lib/impersonate/support";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  return handleJornadas(request, "refresh");
}
